import type { MeasureCtx, RenderCtx } from '@core/define';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { ChatSubagentToolCall, SubagentPhase, ToolNode } from '@/model';
import { SubagentHeader } from './Subagent';
import { subagentRoot, subagentVars } from './subagent.css';

export const SUBAGENT_INDICATOR_W = 16;
const SUBAGENT_ROW_GAP = 2;
const SUBAGENT_STATUS_ROW_H = 24;

type SpawnSubagentToolNode = Extract<ToolNode, { kind: 'spawn-subagent-tool-call' }>;
type UnknownToolNode = Extract<ToolNode, { kind: 'unknown-tool-call' }>;

/** Orkestra conductor's worker launch tool; workers are sub-agents in their own conversations. */
export function isOrchestraSpawnTool(name: string): boolean {
  return /^(?:mcp__)?orkestra(?:__|\.|:)spawn_agent$/.test(name);
}

export function subagentPhase(
  item: Pick<ChatSubagentToolCall, 'status' | 'agentId' | 'background'>
): SubagentPhase {
  if (item.status === 'done') return 'completed';
  if (item.status === 'error') return 'failed';
  // Foreground sub-agents never receive an agentId; only background agents wait to launch.
  return item.background && !item.agentId ? 'spawning' : 'running';
}

/** Replaces the provider's generic "Agent" label with the description when available. */
function subagentDisplayName(item: SpawnSubagentToolNode): string {
  const candidates = [item.name, item.inputSummary, item.title];
  return candidates.find((value) => value && value.trim() && value !== 'Agent') ?? 'Alt ajan';
}

export function subagentHeaderH(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + SUBAGENT_ROW_GAP + SUBAGENT_STATUS_ROW_H;
}

export function subagentHeaderHFromLineHeight(lineHeight: number): number {
  return lineHeight + SUBAGENT_ROW_GAP + SUBAGENT_STATUS_ROW_H;
}

export function subagentFromItem(
  item: SpawnSubagentToolNode,
  ctx: SegmentCtx
): ChatSubagentToolCall {
  const agentId = item.agentId || undefined;
  const status = item.status;
  const error = 'error' in item && typeof item.error === 'string' ? item.error : undefined;
  const name = subagentDisplayName(item);
  return {
    kind: 'subagent',
    id: item.id,
    name,
    status,
    phase: subagentPhase({ status, agentId, background: item.background }),
    agentId,
    background: item.background,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    error,
    toolCallId: item.toolCallId,
    source: 'subagent',
  };
}

/**
 * Maps an Orkestra worker launch call to a sub-agent row. The call finishes as soon as the worker
 * starts; the worker's real phase comes from the host through `resolveSubagentPhase`.
 */
export function orchestraWorkerFromItem(
  item: UnknownToolNode,
  ctx: SegmentCtx
): ChatSubagentToolCall {
  const phase: SubagentPhase =
    item.status === 'error' ? 'failed' : item.status === 'done' ? 'running' : 'spawning';
  return {
    kind: 'subagent',
    id: item.id,
    name: item.inputSummary?.trim() || 'Orkestra işçisi',
    status: item.status,
    phase,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    toolCallId: item.toolCallId,
    source: 'orchestra-worker',
  };
}

function SubagentUnitRender(props: {
  data: ChatSubagentToolCall;
  ctx: RenderCtx;
  vars: Record<string, never>;
}) {
  const height = () => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? subagentHeaderH(ctx) : subagentHeaderHFromLineHeight(20);
  };

  return (
    <div
      class={subagentRoot}
      style={assignInlineVars(subagentVars, pxTokens({ height: height() }))}
    >
      <SubagentHeader item={props.data} height={height()} />
    </div>
  );
}

export const subagentUnitDef = defineUnit<ChatSubagentToolCall>({
  kind: 'subagent',
  margin: { top: 2, bottom: 8 },

  estimate(_item, ctx): number {
    return subagentHeaderH(ctx);
  },

  measure(_item, ctx): number {
    return subagentHeaderH(ctx);
  },

  Render: SubagentUnitRender,
});
