/**
 * unit-registry — segmenter and unit-def registries for the flat unit engine.
 *
 * Two independent maps:
 *
 *   SEGMENTERS   — ChatItem.kind → ItemSegmenter
 *                  Defines how each transcript item is split into RenderUnits.
 *
 *   UNIT_REGISTRY — unit.kind → UnitDef
 *                   Defines how each unit kind is measured and rendered.
 *
 * Adding a new ChatItem kind:
 *   1. Implement a UnitDef<D> and an ItemSegmenter in the appropriate folder.
 *   2. Register the segmenter in SEGMENTERS.
 *   3. Register the UnitDef in UNIT_REGISTRY.
 */

import { artifactUnitDef } from '@components/rows/artifact/artifact.def';
import { handoffDividerUnitDef } from '@components/rows/handoff-divider/handoff-divider.def';
import { mcpAppsOfNode } from '@components/rows/mcp-app/mcp-app-node';
import { mcpAppUnitDef } from '@components/rows/mcp-app/mcp-app.def';
import { messageFromItem, messageUnitDef } from '@components/rows/message/message.def';
import { planFromItem, planUnitDef } from '@components/rows/plan/plan.def';
import { resourceLinkUnitDef } from '@components/rows/resource-link/resource-link.def';
import { thinkingGroupUnitDef } from '@components/rows/thinking/thinking-group.def';
import { thinkingUnitDef } from '@components/rows/thinking/thinking.def';
import {
  createFileDiffFromItem,
  diffUnitDef,
  modifyFileDiffFromItem,
} from '@components/rows/tools/diff/diff.def';
import { executeFromItem, executeUnitDef } from '@components/rows/tools/execute/execute.def';
import {
  deleteFileOpFromItem,
  fileOpUnitDef,
  readFileOpFromItem,
} from '@components/rows/tools/file-op/file-op.def';
import { isOrchestraSpawnNode } from '@components/rows/tools/subagent/orchestra-tool';
import {
  orchestraWorkerFromItem,
  subagentFromItem,
  subagentUnitDef,
} from '@components/rows/tools/subagent/subagent.def';
import { toolGroupUnitDef } from '@components/rows/tools/tool-group/tool-group.def';
import {
  orchestraToolLabel,
  toolFromItem,
  toolUnitDef,
} from '@components/rows/tools/tool/tool.def';
import { turnOutcomeUnitDef } from '@components/rows/turn-outcome/turn-outcome.def';
import { isWidgetNode, widgetOfNode, type ChatWidget } from '@components/rows/widget/widget-node';
import { widgetUnitDef } from '@components/rows/widget/widget.def';
import { workingUnitDef } from '@components/rows/working/working.def';
import type { GroupChrome, ItemSegmenter, SegmentCtx, SegmentItem, UnitDef } from '@core/units';
import { unit } from '@core/units';
import { artifactReferences, uniqueArtifacts } from '@lib/artifact-references';
import {
  toolGroupDisplayLabel,
  type TranscriptArtifact,
} from '@orkestra/core/runtimes/acp/api/client';
import type { ItemNode } from '@state/flatten';
import { deriveToolHeaderState } from '@state/tool-header-state';
import type {
  ActivityItem,
  ChatDiff,
  ChatExecute,
  ChatFileOpToolCall,
  ChatItem,
  ChatMessage,
  ChatPlan,
  ChatSubagentToolCall,
  ChatToolCall,
  SyntheticItem,
  ThinkingGroupItem,
  ToolNode,
} from '@/model';
import { ROW_INSET_X } from './row-metrics';

// ── Native single-unit segmenter for composites ───────────────────────────────
//
// Each composite item becomes exactly one RenderUnit with chrome.insetX so
// the native UnitDef.measure receives the same effective width as Row.tsx used.

type ToolPresentationData =
  | ChatExecute
  | ChatFileOpToolCall
  | ChatDiff
  | ChatPlan
  | ChatSubagentToolCall
  | ChatToolCall
  | ChatWidget;
type RegistryUnitDef = UnitDef<unknown, Record<string, number>>;

function nativePassthrough<T extends SegmentItem>(
  kind: string,
  toData: (item: T, ctx: SegmentCtx) => unknown,
  chrome?: GroupChrome
): ItemSegmenter {
  return {
    kind,
    chrome,
    segment: (item, ctx) => [unit(kind, item, toData(item as T, ctx), { key: 'self' })],
  };
}

/** Chrome shared by all non-user-message composite rows (matches legacy Row.tsx inset). */
const COMPOSITE_CHROME: GroupChrome = { insetX: ROW_INSET_X };

/**
 * User message chrome: full column width (no inset). The card border/padding/bg
 * are handled internally by UserMessageCard, so chrome carries only insetX=0.
 */
const USER_CHROME: GroupChrome = { insetX: 0 };

/**
 * Role-aware message segmenter.
 *
 * Each message becomes exactly one unit with key='self'. The chrome is set
 * per-unit (not on the segmenter) so flatten.ts does not overwrite it with a
 * single shared value — user messages get USER_CHROME (full width), all others
 * get COMPOSITE_CHROME (insetX=ROW_INSET_X).
 */
const messageSegmenter: ItemSegmenter = {
  kind: 'message',
  // No top-level chrome: we set u.chrome per-unit in segment() below so
  // flatten's chrome-copy pass (which only fires when seg.chrome is truthy)
  // cannot overwrite the per-role value we assigned.
  segment: (item, ctx) => {
    const data = messageFromItem(item as ChatMessage, ctx);
    const u = unit('message', item, data, { key: 'self' });
    // A system notice is a compact row aligned like other system rows, not a user card.
    u.chrome = data.role === 'user' && !data.notice ? USER_CHROME : COMPOSITE_CHROME;
    const artifacts =
      data.role === 'assistant'
        ? uniqueArtifacts([...(data.artifacts ?? []), ...artifactReferences(data.text)])
        : [];
    return [u, ...artifactUnits(item, artifacts, ctx)];
  },
};

function toToolGroupNode(item: ToolNode, ctx: SegmentCtx): ItemNode {
  const header = item.kind === 'tool-group' ? toolFromItem(item, ctx) : toPlainUnitData(item, ctx);
  const children =
    item.kind === 'tool-group'
      ? item.children.map((child: ToolNode) => toToolGroupNode(child, ctx))
      : 'children' in item && item.children
        ? item.children.map((child: ToolNode) => toToolGroupNode(child, ctx))
        : [];
  return {
    item: header,
    children,
    headerState: deriveToolHeaderState(
      item,
      children.map((child) => child.headerState),
      ctx.pendingToolCallIds()
    ),
  };
}

/**
 * `show_widget` calls draw their own input as an inline sandboxed iframe. Rows nested inside a
 * group chain cannot host one, so `toToolGroupNode` uses `toPlainUnitData` (plain tool row).
 */
function toUnitData(item: ToolNode, ctx: SegmentCtx): ToolPresentationData {
  return widgetOfNode(item) ?? toPlainUnitData(item, ctx);
}

function toPlainUnitData(
  item: ToolNode,
  ctx: SegmentCtx
): Exclude<ToolPresentationData, ChatWidget> {
  // Orkestra conductor calls render the same for every provider, whatever tool kind they arrive
  // as: Claude Code reports `mcp__orkestra__<tool>` as an unknown tool, Codex reports
  // `mcp.orkestra.<tool>` as an execute call.
  if (item.kind !== 'tool-group' && isOrchestraSpawnNode(item)) {
    return orchestraWorkerFromItem(item, ctx);
  }
  if (orchestraToolLabel(item) !== undefined) return toolFromItem(item, ctx);
  switch (item.kind) {
    case 'execute-tool-call':
      return executeFromItem(item, ctx);
    case 'read-tool-call':
      return item.locations?.length ? readFileOpFromItem(item, ctx) : toolFromItem(item, ctx);
    case 'create-file-tool-call':
      return createFileDiffFromItem(item, ctx);
    case 'modify-file-tool-call':
      return modifyFileDiffFromItem(item, ctx);
    case 'delete-file-tool-call':
      return deleteFileOpFromItem(item, ctx);
    case 'create-plan-tool-call':
      return planFromItem(item, ctx);
    case 'spawn-subagent-tool-call':
      return subagentFromItem(item, ctx);
    case 'unknown-tool-call':
      return toolFromItem(item, ctx);
    case 'tool-group':
      return toolFromItem(item, ctx);
    default:
      return toolFromItem(item, ctx);
  }
}

/**
 * Output card row for an item. `anchorId` names the row: a tool run passes its first command, so
 * the card keeps its id (and its mounted, loaded media) when the next command folds the run into
 * a "Ran N commands" group, whose id changes from `<first>` to `<first>:group`.
 */
function artifactUnits(
  item: SegmentItem,
  artifacts: TranscriptArtifact[],
  ctx: SegmentCtx,
  anchorId: string = item.id
) {
  const visible = artifacts.filter((artifact) => ctx.artifactVisible(artifact));
  if (visible.length === 0) return [];
  const u = unit('artifact', item, { itemId: item.id, items: visible }, { key: 'artifacts' });
  u.id = `${anchorId}#artifacts`;
  return [u];
}

/** Id of the first leaf call of a tool node (a group derives its own id from it). */
function firstLeafId(node: ToolNode): string {
  if (node.kind !== 'tool-group') return node.id;
  const first = node.children[0];
  return first ? firstLeafId(first) : node.id;
}

/** Tools that only consume existing content: paths in their output are source text, not files. */
const CONSUMING_TOOL_KINDS: ReadonlySet<ToolNode['kind']> = new Set([
  'read-tool-call',
  'search-tool-call',
  'web-fetch-tool-call',
]);

function toolArtifacts(item: ToolNode): TranscriptArtifact[] {
  const own = item.kind === 'tool-group' ? [] : [...(item.artifacts ?? [])];
  // Only bytes the tool actually returned count as produced output.
  const outputs = CONSUMING_TOOL_KINDS.has(item.kind)
    ? own.filter((artifact) => artifact.uri.startsWith('data:'))
    : own;
  if (item.kind === 'execute-tool-call' && item.outputText)
    outputs.push(...artifactReferences(item.outputText));
  for (const child of item.children ?? []) outputs.push(...toolArtifacts(child));
  return uniqueArtifacts(outputs);
}

/**
 * MCP app rows for a tool node (and its nested calls), placed right after the tool row or group.
 * They stay empty (zero high) until the host resolves an app for the call.
 */
function mcpAppUnits(item: SegmentItem, tool: ToolNode) {
  return mcpAppsOfNode(tool).map((app) => unit('mcp-app', item, app, { key: app.id }));
}

function toolNodeSegment(kind: ToolNode['kind']): ItemSegmenter {
  return {
    kind,
    chrome: COMPOSITE_CHROME,
    segment(item, ctx) {
      const tool = item as ToolNode;
      // Keep Orkestra worker launches out of the collapsed "Used N tools" group: the group is
      // expanded and each call gets its own row, with workers shown as sub-agent rows.
      const artifacts = artifactUnits(item, toolArtifacts(tool), ctx, firstLeafId(tool));
      if (
        tool.kind === 'tool-group' &&
        tool.children.some((child) => isOrchestraSpawnNode(child) || isWidgetNode(child))
      ) {
        const children = tool.children.map((child) => {
          const nested = 'children' in child ? child.children : undefined;
          if (nested && nested.length > 0) {
            return unit('tool-group', tool, toToolGroupNode(child, ctx), { key: child.id });
          }
          const data = toUnitData(child, ctx);
          return unit(data.kind, tool, data, { key: child.id });
        });
        return [...children, ...mcpAppUnits(item, tool), ...artifacts];
      }
      const children = tool.kind === 'tool-group' ? tool.children : tool.children;
      if (children && children.length > 0) {
        return [
          unit('tool-group', tool, toToolGroupNode(tool, ctx), { key: 'self' }),
          ...mcpAppUnits(item, tool),
          ...artifacts,
        ];
      }
      const data = toUnitData(tool, ctx);
      return [
        unit(data.kind, tool, data, { key: 'self' }),
        ...mcpAppUnits(item, tool),
        ...artifacts,
      ];
    },
  };
}

const activitySegmenter: ItemSegmenter = {
  kind: 'activity',
  chrome: COMPOSITE_CHROME,
  segment(item, ctx) {
    const activity = item as ActivityItem;
    const tools = activity.steps.filter((step) => step.kind !== 'thinking');
    const children = activity.steps.flatMap((step): ItemNode[] => {
      if (step.kind !== 'thinking') {
        const node = toToolGroupNode(step, ctx);
        return step.kind === 'tool-group' ? node.children : [node];
      }
      return [
        {
          item: step,
          children: [],
          headerState: {
            active: step.status === 'thinking',
            awaitingPermission: false,
            error: false,
          },
        },
      ];
    });
    const active = children.some((child) => child.headerState.active);
    const awaitingPermission = children.some((child) => child.headerState.awaitingPermission);
    const calls = tools.flatMap((tool) => (tool.kind === 'tool-group' ? tool.children : [tool]));
    const label = active
      ? 'Çalışıyor'
      : calls.length > 0
        ? toolGroupDisplayLabel(calls)
        : 'Düşündü';
    const data: ItemNode = {
      item: { kind: 'tool', id: item.id, name: label, status: active ? 'running' : 'done' },
      children,
      headerState: { active, awaitingPermission, error: false },
    };
    return [
      unit('tool-group', item, data, { key: 'self' }),
      ...tools.flatMap((tool) => [
        ...mcpAppUnits(tool, tool),
        ...artifactUnits(tool, toolArtifacts(tool), ctx, firstLeafId(tool)),
      ]),
    ];
  },
};

// ── SEGMENTERS ────────────────────────────────────────────────────────────────

/**
 * Maps ChatItem.kind to its ItemSegmenter.
 *
 * Composites use nativePassthrough with COMPOSITE_CHROME so that their native
 * UnitDef.measure receives the same effective width as the old Row.tsx path
 * (rowWidth - 2 * ROW_INSET_X). The chrome.insetX is applied visually by
 * UnitRow and subtracted from rowWidth before nativeMeasureCtx.
 */
export const SEGMENTERS: Record<string, ItemSegmenter> = {
  message: messageSegmenter,
  activity: activitySegmenter,
  thinking: nativePassthrough<ChatItem>('thinking', (item) => item, COMPOSITE_CHROME),
  'thinking-group': nativePassthrough<ThinkingGroupItem>(
    'thinking-group',
    (item) => item,
    COMPOSITE_CHROME
  ),
  tool: nativePassthrough<ChatItem>('tool', (item) => item, COMPOSITE_CHROME),
  'file-op': nativePassthrough<ChatItem>('file-op', (item) => item, COMPOSITE_CHROME),
  execute: nativePassthrough<ChatItem>('execute', (item) => item, COMPOSITE_CHROME),
  diff: nativePassthrough<ChatItem>('diff', (item) => item, COMPOSITE_CHROME),
  plan: nativePassthrough<ChatItem>('plan', (item) => item, COMPOSITE_CHROME),
  subagent: nativePassthrough<ChatItem>('subagent', (item) => item, COMPOSITE_CHROME),
  'resource-link': nativePassthrough<ChatItem>('resource-link', (item) => item, COMPOSITE_CHROME),
  'execute-tool-call': toolNodeSegment('execute-tool-call'),
  'read-tool-call': toolNodeSegment('read-tool-call'),
  'create-file-tool-call': toolNodeSegment('create-file-tool-call'),
  'modify-file-tool-call': toolNodeSegment('modify-file-tool-call'),
  'delete-file-tool-call': toolNodeSegment('delete-file-tool-call'),
  'search-tool-call': toolNodeSegment('search-tool-call'),
  'mcp-tool-call': toolNodeSegment('mcp-tool-call'),
  'web-fetch-tool-call': toolNodeSegment('web-fetch-tool-call'),
  'spawn-subagent-tool-call': toolNodeSegment('spawn-subagent-tool-call'),
  'create-plan-tool-call': toolNodeSegment('create-plan-tool-call'),
  'unknown-tool-call': toolNodeSegment('unknown-tool-call'),
  'tool-group': toolNodeSegment('tool-group'),
  working: nativePassthrough<SyntheticItem>('working', (item) => item, COMPOSITE_CHROME),
  'turn-outcome': nativePassthrough<SyntheticItem>(
    'turn-outcome',
    (item) => item,
    COMPOSITE_CHROME
  ),
  'handoff-divider': nativePassthrough<ChatItem>(
    'handoff-divider',
    (item) => item,
    COMPOSITE_CHROME
  ),
};

// ── UNIT_REGISTRY ─────────────────────────────────────────────────────────────

/**
 * Maps unit.kind to its UnitDef.
 *
 * message: single-unit def; measure/Render handle block layout internally.
 * Composite item unit defs also handle their own internal layout.
 */
export const UNIT_REGISTRY: Record<string, RegistryUnitDef> = {
  artifact: artifactUnitDef as unknown as RegistryUnitDef,
  // Message unit (single unit per message, renders block stack internally)
  message: messageUnitDef as unknown as RegistryUnitDef,
  // Composite item units (single-unit per ChatItem kind)
  diff: diffUnitDef as unknown as RegistryUnitDef,
  plan: planUnitDef as unknown as RegistryUnitDef,
  thinking: thinkingUnitDef as unknown as RegistryUnitDef,
  'thinking-group': thinkingGroupUnitDef as unknown as RegistryUnitDef,
  'file-op': fileOpUnitDef as unknown as RegistryUnitDef,
  subagent: subagentUnitDef as unknown as RegistryUnitDef,
  tool: toolUnitDef as unknown as RegistryUnitDef,
  execute: executeUnitDef as unknown as RegistryUnitDef,
  'resource-link': resourceLinkUnitDef as unknown as RegistryUnitDef,
  // Hierarchical composite: parent tool call with nested children
  'tool-group': toolGroupUnitDef as unknown as RegistryUnitDef,
  working: workingUnitDef as unknown as RegistryUnitDef,
  'turn-outcome': turnOutcomeUnitDef as unknown as RegistryUnitDef,
  'handoff-divider': handoffDividerUnitDef as unknown as RegistryUnitDef,
  widget: widgetUnitDef as unknown as RegistryUnitDef,
  'mcp-app': mcpAppUnitDef as unknown as RegistryUnitDef,
};
