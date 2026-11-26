import { useTheme } from '@components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@components/engine/row-metrics';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { CollapseHeader } from '@components/primitives/CollapseHeader';
import type { MeasureCtx, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import type { Block } from '@core/markdown/document';
import { flattenBlockHeadings } from '@core/markdown/parse';
import { defineUnit } from '@core/units';
import { formatCompactElapsed } from '@state/turn-fold';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { ChatThinking } from '@/model';
import { thinkingCardVars, thinkingRoot, type ThinkingStyleVars } from './thinking.css';
import { sx } from '@styles/sprinkles.css';

export type ThinkingVars = {
  /** Measure-only: vertical padding baked into the body block-stack layout. */
  padY: number;
  /** Measure-only: kept for backwards compatibility with callers referencing THINKING_VARS. */
  windowH: number;
};

export const THINKING_VARS: ThinkingVars = {
  padY: 8,
  windowH: 72,
};

function thinkingHeaderH(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function layoutThinkingBody(blocks: Block[], ctx: MeasureCtx, padY: number) {
  return layoutBlockStack(blocks, ctx, { padY });
}

const REAL_EPOCH_MS = 1_000_000_000_000;

function ThinkingHeader(props: { item: ChatThinking; expanded: boolean; headerH: number }) {
  const mountTime = Date.now();
  const resolveStart = () =>
    typeof props.item.startedAt === 'number' &&
    Number.isFinite(props.item.startedAt) &&
    props.item.startedAt >= REAL_EPOCH_MS
      ? props.item.startedAt
      : mountTime;
  const [elapsedMs, setElapsedMs] = createSignal(Math.max(0, Date.now() - resolveStart()));

  let timer: ReturnType<typeof setInterval> | undefined;

  createEffect(() => {
    if (props.item.status === 'thinking') {
      setElapsedMs(Math.max(0, Date.now() - resolveStart()));
      timer = setInterval(() => {
        setElapsedMs(Math.max(0, Date.now() - resolveStart()));
      }, 1000);
    } else {
      clearInterval(timer);
      timer = undefined;
    }
  });
  onCleanup(() => clearInterval(timer));

  const label = () => {
    if (props.item.status === 'thinking') {
      const dur = formatCompactElapsed(elapsedMs());
      return dur ? `Düşünüyor  ${dur}` : 'Düşünüyor';
    }
    if (props.item.durationMs !== undefined) {
      const dur = formatCompactElapsed(props.item.durationMs);
      if (!dur) return 'Kısaca düşündü';
      return `${dur} düşündü`;
    }
    return 'Düşündü';
  };

  return (
    <CollapseHeader
      id={props.item.id}
      expanded={props.expanded}
      active={props.item.status === 'thinking'}
      thinkingDots
      height={props.headerH}
    >
      <span
        style={{ 'font-variant-numeric': 'tabular-nums' }}
        aria-live={props.item.status === 'thinking' ? 'polite' : undefined}
        aria-atomic={props.item.status === 'thinking' ? 'false' : undefined}
      >
        {label()}
      </span>
    </CollapseHeader>
  );
}

export function thinkingMeasure(item: ChatThinking, ctx: MeasureCtx, vars: ThinkingVars): number {
  const headerH = thinkingHeaderH(ctx);
  const isExpanded = ctx.expanded(item.id);

  if (!isExpanded) return headerH;

  const blocks = flattenBlockHeadings(ctx.caches.parseBlocks(item.id, item.text ?? ''));
  const body = layoutThinkingBody(blocks, ctx, vars.padY);
  return headerH + body.height;
}

export function ThinkingUnitRender(props: {
  data: ChatThinking;
  ctx: RenderCtx;
  vars: ThinkingVars;
}) {
  const theme = useTheme();
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const headerH = () => theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H;

  const body = createMemo(() => {
    if (!isExpanded()) return null;
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = flattenBlockHeadings(
      ctx.caches.parseBlocks(props.data.id, props.data.text ?? '')
    );
    return layoutThinkingBody(blocks, ctx, props.vars.padY);
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return headerH();
    return thinkingMeasure(props.data, ctx, props.vars);
  });

  const styleVars = (): ThinkingStyleVars => ({ height: totalH() });

  return (
    <div
      class={`${sx({ color: 'fgPassive' })} ${thinkingRoot}`}
      style={assignInlineVars(thinkingCardVars, pxTokens(styleVars()))}
    >
      <ThinkingHeader item={props.data} expanded={isExpanded()} headerH={headerH()} />
      <Show when={isExpanded()}>
        <Show when={body()}>{(b) => <BlockStackView node={b()} />}</Show>
      </Show>
    </div>
  );
}

export const thinkingUnitDef = defineUnit<ChatThinking, ThinkingVars>({
  kind: 'thinking',
  margin: { top: 6, bottom: 6 },
  vars: THINKING_VARS,

  estimate(item, ctx, vars): number {
    const headerH = thinkingHeaderH(ctx);
    const isExpanded = ctx.expanded(item.id);

    if (!isExpanded) return headerH;

    const lines = Math.max(1, Math.ceil((item.text?.length ?? 0) / 60));
    return headerH + 2 * vars.padY + lines * ctx.theme.fonts.body.lineHeight;
  },

  measure: thinkingMeasure,

  Render: ThinkingUnitRender,
});
