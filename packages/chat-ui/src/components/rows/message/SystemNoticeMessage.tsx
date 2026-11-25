/**
 * A user-role message the host application sent on its own (for example the context hand-over
 * request). It stays visible and honest, but as a one-line notice: the label says what was sent
 * and the full text opens on demand (click toggles via `data-collapse-id`, like thinking rows).
 *
 * Measurement and rendering share `systemNoticeLayout`, so the reserved row height always matches
 * what is drawn: header only when collapsed; header + gap + bordered full-text panel when expanded.
 * The header is always exactly one line: glyph and label share one flex row and the label truncates
 * with an ellipsis instead of wrapping (see `system-notice.css.ts`), at any pane width.
 * Ordinary user prompts never take this path; they are always shown in full (`UserMessageCard`).
 */
import { useTheme } from '@components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@components/engine/row-metrics';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { CollapseHeader } from '@components/primitives/CollapseHeader';
import type { StackLayout } from '@core/compose';
import type { MeasureCtx, Measured, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import { Show, createMemo } from 'solid-js';
import type { ChatMessage } from '@/model';
import type { MessageVars } from './metrics';
import { noticeGlyph, noticeLabel, noticeText, noticeToggle } from './system-notice.css';
import { vars as themeVars } from '@styles/theme.css';

function headerH(ctx: Pick<MeasureCtx, 'theme'>): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function bodyInnerWidth(width: number, vars: MessageVars): number {
  return Math.max(0, width - 2 * vars.noticeBodyPadX - 2 * vars.cardBorder);
}

type NoticeLayout = {
  headerH: number;
  /** Full-text panel (border box) height; 0 when collapsed. */
  bodyH: number;
  stack: Measured<StackLayout> | null;
  totalH: number;
};

function systemNoticeLayout(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): NoticeLayout {
  const header = headerH(ctx);
  if (!ctx.expanded(item.id)) return { headerH: header, bodyH: 0, stack: null, totalH: header };
  const blocks = ctx.caches.parseBlocks(item.id, item.text);
  const stack =
    blocks.length > 0
      ? layoutBlockStack(
          blocks,
          { ...ctx, width: bodyInnerWidth(ctx.width, vars) },
          { isCollapsed: ctx.isCollapsed }
        )
      : null;
  const contentH = stack ? stack.height : ctx.theme.fonts.body.lineHeight;
  const bodyH = contentH + 2 * vars.noticeBodyPadY + 2 * vars.cardBorder;
  return { headerH: header, bodyH, stack, totalH: header + vars.noticeBodyGap + bodyH };
}

export function measureSystemNotice(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  return systemNoticeLayout(item, ctx, vars).totalH;
}

function HandoffGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={noticeGlyph}
    >
      <path d="M4 8h14l-4-4M20 16H6l4 4" />
    </svg>
  );
}

export function SystemNoticeMessage(props: {
  data: ChatMessage;
  ctx: RenderCtx;
  vars: MessageVars;
}) {
  const theme = useTheme();
  const mCtx = () => props.ctx.measureCtx?.();
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const layout = createMemo<NoticeLayout>(() => {
    const ctx = mCtx();
    if (!ctx) {
      const h = headerH({ theme: theme() });
      return { headerH: h, bodyH: 0, stack: null, totalH: h };
    }
    return systemNoticeLayout(props.data, ctx, props.vars);
  });

  return (
    <div data-system-notice={props.data.id} style={{ height: `${layout().totalH}px` }}>
      <CollapseHeader
        id={props.data.id}
        expanded={isExpanded()}
        height={layout().headerH}
        labelClass={noticeLabel}
      >
        <HandoffGlyph />
        <span class={noticeText} data-system-notice-label>
          {props.data.notice?.label}
        </span>
        <span class={noticeToggle}>{isExpanded() ? '· gizle' : '· tam metni göster'}</span>
      </CollapseHeader>
      <Show when={layout().bodyH > 0}>
        <div
          style={{
            'margin-top': `${props.vars.noticeBodyGap}px`,
            height: `${layout().bodyH}px`,
            padding: `${props.vars.noticeBodyPadY}px ${props.vars.noticeBodyPadX}px`,
            border: `${props.vars.cardBorder}px solid ${themeVars.border}`,
            'border-radius': '8px',
            'box-sizing': 'border-box',
            color: themeVars.fgMuted,
            overflow: 'hidden',
          }}
        >
          <Show when={layout().stack} fallback={<div>{props.data.text}</div>}>
            {(stack) => <BlockStackView node={stack()} />}
          </Show>
        </div>
      </Show>
    </div>
  );
}
