import type { MeasureCtx, RenderCtx } from '@core/define';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatDiff, ToolNode } from '@/model';
import { DiffHeader } from './Diff';
import { countChanges, type DiffRow } from './diff-lines';
import { langFromPath } from './lang';
import { diffCardVars, diffRoot, type DiffStyleVars } from './diff.css';

export type DiffVars = {
  /** Style-relevant: consumed by diffCardVars contract. */
  headerH: number;
  /** Measure-only: not in CSS contract. */
  maxLines: number;
  /** Measure-only: not in CSS contract. */
  context: number;
  /** Measure-only: border width on each side of the diff block. */
  border: number;
};

const DIFF_VARS: DiffVars = {
  headerH: 32,
  maxLines: 8,
  context: 1,
  border: 1,
};

export function createFileDiffFromItem(
  item: Extract<ToolNode, { kind: 'create-file-tool-call' }>,
  ctx: SegmentCtx
): ChatDiff {
  return {
    kind: 'diff',
    id: item.id,
    path: item.path,
    oldText: null,
    newText: item.content,
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
  };
}

export function modifyFileDiffFromItem(
  item: Extract<ToolNode, { kind: 'modify-file-tool-call' }>,
  ctx: SegmentCtx
): ChatDiff {
  return {
    kind: 'diff',
    id: item.id,
    path: item.path,
    oldText: item.oldText,
    newText: item.newText,
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
  };
}

export type DiffLayout = {
  kind: 'diff';
  previewRows: DiffRow[];
  adds: number;
  dels: number;
  lang: string | undefined;
  truncated: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function diffUnitH(_item: ChatDiff, _ctx: MeasureCtx, vars: DiffVars): number {
  return vars.headerH;
}

// ── Render ────────────────────────────────────────────────────────────────────

function DiffUnitRender(props: { data: ChatDiff; ctx: RenderCtx; vars: DiffVars }) {
  const mCtx = () => props.ctx.measureCtx?.();

  const layout = createMemo<DiffLayout | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const rows = ctx.caches.computeDiff(props.data.oldText, props.data.newText);
    const { adds, dels } = countChanges(rows);
    const lang = langFromPath(props.data.path);
    return { kind: 'diff', previewRows: [], adds, dels, lang, truncated: false };
  });

  const styleVars = (): DiffStyleVars => ({ height: props.vars.headerH, headerH: props.vars.headerH });

  return (
    <div class={diffRoot} style={assignInlineVars(diffCardVars, pxTokens(styleVars()))}>
      <Show when={layout()}>
        {(l) => (
          <DiffHeader
            item={props.data}
            adds={l().adds}
            dels={l().dels}
            headerH={props.vars.headerH}
            hasBody={false}
          />
        )}
      </Show>
    </div>
  );
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const diffUnitDef = defineUnit<ChatDiff, DiffVars>({
  kind: 'diff',
  margin: { top: 2, bottom: 4 },
  vars: DIFF_VARS,

  estimate(_item, _ctx, vars): number {
    return vars.headerH;
  },

  measure(item, ctx, vars): number {
    return diffUnitH(item, ctx, vars);
  },

  Render: DiffUnitRender,
});
