// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/source-control-azure-devops/src/server/azureDevOpsIssueJson.ts
import type {
  AzureDevOpsIdentityValue,
  AzureDevOpsWorkItem,
} from '../../../integrations/impl/azure-devops/types';
import type { IssueData, IssueDetail } from '../../types';

/** Bitmiş sayılan durum kategorileri; özel süreçler sütunlarını kendileri adlandırır. */
const FINISHED_CATEGORIES: ReadonlySet<string> = new Set(['Resolved', 'Completed', 'Removed']);

/** Türleri durum bildirmeyen projeler için Azure'un hazır süreçlerinin bitmiş durumları. */
export const STOCK_CLOSED_STATES: ReadonlySet<string> = new Set([
  'closed',
  'done',
  'removed',
  'resolved',
  'completed',
]);

export type WorkItemTypeStates = {
  name: string;
  states?: { name: string; category: string }[] | null;
}[];

/** Projenin bitmiş durum adları (küçük harf), iş öğesi türlerinin durum kategorilerinden. */
export function closedStateNames(types: WorkItemTypeStates): ReadonlySet<string> {
  const names = types.flatMap((type) =>
    (type.states ?? []).flatMap((state) =>
      FINISHED_CATEGORIES.has(state.category) ? [state.name.toLowerCase()] : []
    )
  );
  return names.length === 0 ? STOCK_CLOSED_STATES : new Set(names);
}

export function identityName(value: AzureDevOpsIdentityValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  return value.displayName?.trim() || value.uniqueName?.trim() || undefined;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Azure açıklamaları HTML'dir; ajan bağlamı için düz metne indirgenir. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function workItemWebUrl(organizationUrl: string, project: string, id: number): string {
  return `${organizationUrl.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

export function toIssueData(
  item: AzureDevOpsWorkItem,
  context: { organizationUrl: string; project: string }
): IssueData {
  const fields = item.fields ?? {};
  const project = fields['System.TeamProject']?.trim() || context.project;
  const assignee = identityName(fields['System.AssignedTo']);
  const description = htmlToText(
    fields['System.Description'] || fields['Microsoft.VSTS.TCM.ReproSteps']
  );
  return {
    identifier: `#${item.id}`,
    title: fields['System.Title']?.trim() || `Work item ${item.id}`,
    url: item._links?.html?.href || workItemWebUrl(context.organizationUrl, project, item.id),
    description: description || undefined,
    status: fields['System.State'] ?? undefined,
    assignees: assignee ? [assignee] : undefined,
    project,
    updatedAt: fields['System.ChangedDate'] ?? fields['System.CreatedDate'] ?? undefined,
  };
}

export function toIssueDetail(
  item: AzureDevOpsWorkItem,
  context: { organizationUrl: string; project: string },
  comments: { author?: string; text: string; createdAt?: string }[]
): IssueDetail {
  const data = toIssueData(item, context);
  const fields = item.fields ?? {};
  const header = [
    `Type: ${fields['System.WorkItemType'] ?? 'Work item'}`,
    ...(fields['System.Tags'] ? [`Tags: ${fields['System.Tags']}`] : []),
    ...(identityName(fields['System.CreatedBy'])
      ? [`Created by: ${identityName(fields['System.CreatedBy'])}`]
      : []),
  ];
  const commentLines = comments
    .map((comment) => ({ ...comment, text: htmlToText(comment.text) }))
    .filter((comment) => comment.text.length > 0)
    .map(
      (comment) =>
        `- ${comment.author ?? 'Unknown'}${comment.createdAt ? ` (${comment.createdAt})` : ''}: ${comment.text}`
    );
  return {
    ...data,
    context: [
      header.join('\n'),
      ...(commentLines.length > 0 ? [`Comments:\n${commentLines.join('\n')}`] : []),
    ].join('\n\n'),
  };
}
