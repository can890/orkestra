import type { StackLayout } from '@core/compose';
import { type Measured, type MeasureCtx, type RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatPlan, PlanEntryPriority, PlanEntryStatus, ToolNode } from '@/model';
import { PlanList } from './Plan';
import { planCard, planVars, type PlanStyleVars } from './plan.css';

export type PlanVars = {
  /** Border width (px) of the plan card. */
  border: number;
  /** Horizontal padding (px) inside the plan card border, each side. */
  padX: number;
  /** Vertical padding (px) inside the entry list, applied top and bottom. */
  padY: number;
  /** Width (px) of the status-icon box to the left of each entry body. */
  iconBox: number;
  /** Minimum height (px) of an entry, matching the status-icon box. */
  entryMinH: number;
  /** Horizontal gap (px) between the status icon and the entry text. */
  iconGap: number;
  /** Vertical gap (px) between consecutive plan entries. */
  entryGap: number;
};

export function planFromItem(
  item: Extract<ToolNode, { kind: 'create-plan-tool-call' }>,
  ctx: SegmentCtx
): ChatPlan {
  const entries = item.entries ?? ctx.plan()?.entries ?? [];
  return {
    kind: 'plan',
    id: item.id,
    entries,
    streaming: item.status === 'running',
  };
}

export type PlanEntryLaid = {
  /** Pre-measured block stack for this entry's content. */
  measured: Measured<StackLayout>;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
};

/** Total horizontal chrome: 2*padX + 2*border. */
function chromeX(vars: PlanVars): number {
  return 2 * vars.padX + 2 * vars.border;
}

/** Total vertical chrome: top border + bottom border. */
function chromeY(vars: PlanVars): number {
  return 2 * vars.border;
}

/** Total entry indent: icon box + icon gap. */
function entryIndent(vars: PlanVars): number {
  return vars.iconBox + vars.iconGap;
}

/** Lay out each entry's content into a measured block stack. */
function measureEntries(item: ChatPlan, ctx: MeasureCtx, vars: PlanVars): PlanEntryLaid[] {
  const bodyWidth = Math.max(40, ctx.width - chromeX(vars) - entryIndent(vars));
  return item.entries.map((entry, i) => {
    const blocks = ctx.caches.parseBlocks(`${item.id}:e${i}`, entry.content);
    const measured = layoutBlockStack(blocks, { ...ctx, width: bodyWidth }, { padY: 0 });
    return { measured, status: entry.status, priority: entry.priority };
  });
}

function listHeight(entries: PlanEntryLaid[], vars: PlanVars): number {
  if (entries.length === 0) return 0;
  const totalEntryH = entries.reduce(
    (sum, entry) => sum + Math.max(entry.measured.height, vars.entryMinH),
    0
  );
  const gaps = entries.length > 1 ? (entries.length - 1) * vars.entryGap : 0;
  return totalEntryH + gaps + 2 * vars.padY;
}

function planMeasure(item: ChatPlan, ctx: MeasureCtx, vars: PlanVars): number {
  if (item.entries.length === 0) return 0;
  const entries = measureEntries(item, ctx, vars);
  return listHeight(entries, vars) + chromeY(vars);
}

function PlanUnitRender(props: { data: ChatPlan; ctx: RenderCtx; vars: PlanVars }) {
  const mCtx = () => props.ctx.measureCtx?.();

  const entries = createMemo(() => {
    const ctx = mCtx();
    if (!ctx || props.data.entries.length === 0) return [];
    return measureEntries(props.data, ctx, props.vars);
  });

  const totalH = createMemo(() => {
    if (props.data.entries.length === 0) return 0;
    const ctx = mCtx();
    if (!ctx) return chromeY(props.vars) + 2 * props.vars.padY;
    return planMeasure(props.data, ctx, props.vars);
  });

  const listStyleVars = (): PlanStyleVars => ({
    cardH: totalH(),
    padX: props.vars.padX,
    padY: props.vars.padY,
    iconBox: props.vars.iconBox,
    entryMinH: props.vars.entryMinH,
    iconGap: props.vars.iconGap,
    entryGap: props.vars.entryGap,
  });

  return (
    <Show when={props.data.entries.length > 0}>
      <div
        class={planCard}
        style={assignInlineVars(planVars, pxTokens(listStyleVars()))}
        role="region"
        aria-label="Çalışma adımları"
      >
        <PlanList entries={entries()} />
      </div>
    </Show>
  );
}

export const planUnitDef = defineUnit<ChatPlan, PlanVars>({
  kind: 'plan',
  margin: { top: 10, bottom: 10 },
  vars: {
    border: 1,
    padX: 18,
    padY: 14,
    iconBox: 16,
    entryMinH: 20,
    iconGap: 11,
    entryGap: 10,
  },

  estimate(item, ctx, vars): number {
    if (item.entries.length === 0) return 0;
    const lineH = ctx.theme.fonts.body.lineHeight;
    const entryH = Math.max(lineH, vars.entryMinH);
    const gaps = item.entries.length > 1 ? (item.entries.length - 1) * vars.entryGap : 0;
    const listH = item.entries.length * entryH + gaps + 2 * vars.padY;
    return listH + chromeY(vars);
  },

  measure: planMeasure,

  Render: PlanUnitRender,
});
