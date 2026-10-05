import { ROW_H } from '@components/engine/row-metrics';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { ChatToolCall, ToolNode } from '@/model';
import { Tool } from './Tool';
import { toolRoot, toolVars } from './tool.css';

/** User-facing labels for the Orkestra conductor tools. */
const ORCHESTRA_TOOL_LABELS: Record<string, string> = {
  list_agents: 'Ajanları değerlendir',
  spawn_agent: 'İşçi başlat',
  message_agent: 'İşçiye mesaj',
  wait_for_agents: 'İşçileri bekle',
  get_agent_result: 'İşçi sonucu',
  list_workers: 'İşçileri listele',
  cancel_agent: 'İşçiyi durdur',
};

function orchestraToolLabel(name: string): string | undefined {
  const match = /^(?:mcp__)?orkestra(?:__|\.|:)(\w+)$/.exec(name);
  return match ? ORCHESTRA_TOOL_LABELS[match[1]!] : undefined;
}

export function toolFromItem(item: ToolNode, ctx: SegmentCtx): ChatToolCall {
  const base = 'toolCallId' in item ? item : null;
  const name =
    item.kind === 'read-tool-call'
      ? item.title
      : item.kind === 'search-tool-call'
        ? 'Search'
        : item.kind === 'mcp-tool-call'
          ? 'MCP'
          : item.kind === 'web-fetch-tool-call'
            ? 'Fetch'
            : item.kind === 'spawn-subagent-tool-call'
              ? 'Subagent'
              : item.kind === 'unknown-tool-call'
                ? (orchestraToolLabel(item.name) ?? item.name)
                : item.kind === 'tool-group'
                  ? item.label
                  : 'Tool';
  const inputSummary =
    item.kind === 'read-tool-call'
      ? undefined
      : item.kind === 'search-tool-call'
        ? `${item.query}${item.matchCount !== undefined ? ` (${item.matchCount} matches)` : ''}`
        : item.kind === 'mcp-tool-call'
          ? [item.server, item.tool].filter(Boolean).join('.')
          : item.kind === 'web-fetch-tool-call'
            ? (item.pageTitle ?? item.url)
            : item.kind === 'spawn-subagent-tool-call'
              ? `${item.name}${item.background ? ' (background)' : ''}`
              : item.kind === 'unknown-tool-call'
                ? (item.inputSummary ??
                  (orchestraToolLabel(item.name) ? undefined : (item.toolKind ?? undefined)))
                : base?.inputSummary;
  return {
    kind: 'tool',
    id: item.id,
    name,
    status: 'status' in item ? item.status : 'done',
    awaitingPermission: base ? ctx.pendingToolCallIds().has(base.toolCallId) : false,
    inputSummary,
  };
}

export const toolUnitDef = defineUnit<ChatToolCall, { rowH: number }>({
  kind: 'tool',
  margin: { top: 2, bottom: 2 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars): number {
    return vars.rowH;
  },

  Render(props) {
    return (
      <div class={toolRoot} style={assignInlineVars(toolVars, pxTokens({ rowH: props.vars.rowH }))}>
        <Tool item={props.data} />
      </div>
    );
  },
});
