import { style } from '@vanilla-extract/css';
import type { MessageStyleVars } from './metrics';
import { fadeOverlayTop } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

/**
 * Group-hover marker for the user message row: hovering (or focusing inside) the row reveals the
 * meta row (time + actions). Keyed to this dedicated empty marker so the reveal cannot leak to or
 * from the messageGroup/codeGroup hover contexts of nested code blocks or sibling messages.
 */
export const userCardGroup = style({});

// ── Runtime geometry contract ─────────────────────────────────────────────────
// Set per-instance via assignInlineVars in UserMessageCard.tsx.

export const cardVars = createVariableThemeContract<MessageStyleVars & { height: number }>({
  height: null,
  userCardPadX: null,
  userCardPadY: null,
  cardBorder: null,
  attachThumb: null,
  attachGap: null,
});

export const userRowContainer = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  width: '100%',
});

// ── UserMessageCard ───────────────────────────────────────────────────────────

/**
 * Claude-style user bubble: right-aligned, hugs its text (width set inline from the layout),
 * one step off the page background, no visible border, no shadow, soft 16 px corners.
 * The 1 px border stays (transparent, painted over by the background) so the geometry matches
 * `userMessageGeometry`; never a visible frame or a header (earlier user decision).
 */
export const card = style({
  position: 'relative',
  flexShrink: 0,
  height: cardVars.height,
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  borderRadius: '16px',
  borderStyle: 'solid',
  borderWidth: cardVars.cardBorder,
  borderColor: 'transparent',
  background: vars.userCardBg,
  color: vars.fg,
  paddingLeft: cardVars.userCardPadX,
  paddingRight: cardVars.userCardPadX,
  paddingTop: cardVars.userCardPadY,
  paddingBottom: cardVars.userCardPadY,
  // Text is laid out to fit; this only guards against anything wider (long tokens, code) ever
  // escaping the bubble or the pane. Never scrolls: the message is always shown in full.
  overflow: 'hidden',
});

/**
 * Meta row under the bubble: relative time + icon actions, right-aligned, muted. Its height is
 * reserved in measure() (`userFooterH`) whether or not it is visible, so revealing it never
 * moves the list. Hidden until the row is hovered or focused (calmer than always-on); the only
 * motion is a one-off opacity fade on that state change.
 */
export const userActionBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '2px',
  paddingTop: '4px',
  boxSizing: 'border-box',
  width: '100%',
  opacity: 0,
  transition: 'opacity 140ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
    [`${userCardGroup}:focus-within &`]: { opacity: 1 },
  },
});

/** Kept for the copy button's class slot; the whole meta row handles the reveal. */
export const userActionReveal = style({});

export const userActionBtn = style({
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: 0,
  border: 'none',
  background: 'transparent',
  borderRadius: vars.radiusSm,
  color: vars.fgPassive,
  transition: 'color 150ms ease, background-color 150ms ease',
  selectors: {
    '&:hover': { color: vars.fg, backgroundColor: vars.bg2 },
    '&:focus-visible': {
      outline: '2px solid currentColor',
      outlineOffset: '1px',
      color: vars.fg,
    },
  },
});

export const userTimestamp = style({
  fontSize: '12px',
  lineHeight: '16px',
  color: vars.fgPassive,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  padding: '0 6px 0 4px',
  userSelect: 'none',
});

/** Attachments sit right-aligned directly above the bubble (as in Claude), not inside it. */
export const attachmentStrip = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  flexShrink: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  gap: cardVars.attachGap,
  paddingBottom: cardVars.attachGap,
});

export const attachRow = style({
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  maxWidth: '100%',
  gap: cardVars.attachGap,
});

export const attachThumbBtn = style({
  position: 'relative',
  display: 'block',
  padding: 0,
  margin: 0,
  boxSizing: 'border-box',
  // Hairline drawn as an inset outline, not a border: a border would make the button 2 px larger
  // than `attachThumb` and break the strip height that measure() reserves.
  border: 'none',
  outline: '1px solid rgba(128, 128, 128, 0.18)',
  outlineOffset: '-1px',
  background: 'rgba(128, 128, 128, 0.08)',
  cursor: 'pointer',
  borderRadius: '12px',
  lineHeight: 0,
  overflow: 'hidden',
  transition: 'outline-color 140ms ease',
  selectors: {
    '&:hover': {
      outlineColor: 'rgba(128, 128, 128, 0.4)',
    },
    '&:focus-visible': {
      outline: '2px solid currentColor',
      outlineOffset: '2px',
    },
  },
});

export const attachThumb = style({
  display: 'block',
  width: cardVars.attachThumb,
  height: cardVars.attachThumb,
  borderRadius: '12px',
  objectFit: 'cover',
});

export const attachVideoBadge = style({
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(10, 12, 16, 0.34)',
  color: '#ffffff',
  pointerEvents: 'none',
});

export const attachPlaceholder = style({
  width: cardVars.attachThumb,
  height: cardVars.attachThumb,
  borderRadius: '12px',
  background: vars.bg2,
  color: vars.fgMuted,
  display: 'grid',
  placeItems: 'center',
});

export const attachFilePill = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '32px',
  padding: '0 10px',
  borderRadius: '8px',
  background: 'rgba(128, 128, 128, 0.14)',
  color: vars.fgBody,
  fontSize: '12px',
  lineHeight: '16px',
  boxSizing: 'border-box',
  overflow: 'hidden',
});

export const attachFileName = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
});

// ── PinnedUserMessage ─────────────────────────────────────────────────────────

export const pinnedBackdrop = style({
  background: `color-mix(in srgb, ${vars.bg} 80%, transparent)`,
  backdropFilter: 'blur(8px)',
  pointerEvents: 'auto',
});

/** Sabitlenmiş isteğin satırı: hap sağa yaslı, arka plan şeffaf (yalnızca hap tıklanabilir). */
export const pinnedPillRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  boxSizing: 'border-box',
  paddingTop: '8px',
  paddingBottom: '4px',
  pointerEvents: 'none',
});

/** Tek satırlık, yuvarlak istek hapı (Antigravity tarzı). */
export const pinnedPill = style({
  pointerEvents: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  maxWidth: 'min(85%, 720px)',
  minWidth: 0,
  height: '36px',
  padding: '0 18px',
  borderRadius: '999px',
  border: `1px solid ${vars.userCardBorder}`,
  background: `color-mix(in srgb, ${vars.userCardBg} 92%, transparent)`,
  backdropFilter: 'blur(8px)',
  color: vars.fgBody,
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '20px',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.22)',
  selectors: {
    '&:hover': { borderColor: vars.userCardBorderHover },
    '&:focus-visible': { outline: `2px solid ${vars.userCardBorderHover}`, outlineOffset: '2px' },
  },
});

export const pinnedPillText = style({
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
});

export const pinnedPillAttachments = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
  fontSize: '12px',
  color: vars.fgMuted,
});

export const pinnedScrollFade = style([
  fadeOverlayTop,
  {
    pointerEvents: 'none',
    height: '16px',
  },
]);
