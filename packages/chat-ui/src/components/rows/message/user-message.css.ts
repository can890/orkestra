import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { MessageStyleVars } from './metrics';
import { fadeOverlayBottom, fadeOverlayTop } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

/**
 * Dedicated group-hover marker for the stop button.
 *
 * Apply this class to the user card root so that hovering anywhere on the card
 * reveals the stop button. Keying the reveal to this dedicated empty marker
 * (rather than a structural class like cardRoot) isolates it from the
 * messageGroup/codeGroup hover reveals already present in descendant nodes,
 * preventing cross-nesting leakage — same pattern as the copy-button isolation.
 */
export const userCardGroup = style({});

// ── Runtime geometry contract ─────────────────────────────────────────────────
// Set per-instance via assignInlineVars in message.def.tsx.

export const cardVars = createVariableThemeContract<MessageStyleVars & { height: number }>({
  height: null,
  userCardPadX: null,
  userCardPadY: null,
  cardBorder: null,
  attachThumb: null,
  attachGap: null,
});

export const cardRoot = style({ height: cardVars.height });

export const userRowContainer = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  width: '100%',
});

// ── UserMessageCard ───────────────────────────────────────────────────────────

export const card = recipe({
  base: {
    position: 'relative',
    borderRadius: '22px',
    maxWidth: '100%',
    // Kullanıcı isteği kutusuz gösterilir: arka plan ve çerçeve yok, yalnızca sağa yaslı metin.
    // Çerçeve genişliği ve iç boşluk yerleşim ölçümleriyle (metrics) uyumlu kalsın diye korunur.
    borderStyle: 'solid',
    borderWidth: cardVars.cardBorder,
    borderColor: 'transparent',
    background: 'transparent',
    color: vars.fg,
    paddingLeft: cardVars.userCardPadX,
    paddingRight: cardVars.userCardPadX,
    paddingTop: cardVars.userCardPadY,
    paddingBottom: cardVars.userCardPadY,
    boxSizing: 'border-box',
  },
  variants: {
    state: {
      static: {},
      // Uzun, katlanmış istek tıklanınca açılır; üzerine gelince ince çerçeveyle belli edilir.
      overflowing: {
        selectors: {
          '&:hover': { borderColor: vars.userCardBorder },
        },
      },
    },
    /** Eskiden etkin isteğin üzerine gelince çerçeve gösterirdi; kutusuz görünümde kullanılmıyor. */
    current: {
      false: {},
      true: {},
    },
  },
});

/**
 * Stop button — absolutely positioned top-right of the user message card.
 *
 * Isolated reveal: opacity 0 by default; revealed only when `userCardGroup`
 * is hovered (`${userCardGroup}:hover &`). The reveal selector is on this
 * style itself (not a shared base), and keyed to the dedicated `userCardGroup`
 * marker, so it cannot leak to/from the messageGroup/codeGroup hover contexts
 * in descendant code blocks or sibling assistant messages.
 */
export const stopButtonOverlay = style({
  position: 'absolute',
  top: '6px',
  right: '6px',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px',
  borderRadius: vars.radiusSm,
  border: 'none',
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
    '&:hover': { color: vars.fg },
  },
});

/** Rewind button: same isolated hover reveal as the stop button, at the card's top-right. */
export const rewindButtonOverlay = style([stopButtonOverlay]);

/** Shifts the rewind button left of the stop button while a turn is generating. */
export const stopButtonOffset = style({ right: '30px' });

export const userActionBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '2px',
  paddingTop: '4px',
  paddingRight: '4px',
  boxSizing: 'border-box',
  width: '100%',
});

export const userActionReveal = style({
  opacity: 0,
  transition: 'opacity 140ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
    [`${userCardGroup}:focus-within &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
  },
});

export const userActionBtn = style([
  userActionReveal,
  {
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
    transition: 'opacity 140ms ease, color 150ms ease, background-color 150ms ease',
    selectors: {
      '&:hover': { color: vars.fg, backgroundColor: vars.bg2 },
      '&:focus-visible': {
        outline: '2px solid currentColor',
        outlineOffset: '1px',
        color: vars.fg,
      },
    },
  },
]);

export const userTimestamp = style({
  fontSize: '11px',
  lineHeight: '16px',
  color: vars.fgPassive,
  fontVariantNumeric: 'tabular-nums',
  padding: '0 4px',
  userSelect: 'none',
  opacity: 0.72,
  transition: 'opacity 140ms ease, color 140ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1, color: vars.fgMuted },
  },
});

export const attachmentStrip = style({
  display: 'flex',
  flexDirection: 'column',
  gap: cardVars.attachGap,
  paddingBottom: cardVars.attachGap,
});

export const attachRow = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: cardVars.attachGap,
});

export const attachThumbBtn = style({
  position: 'relative',
  display: 'block',
  padding: 0,
  margin: 0,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  background: 'rgba(255, 255, 255, 0.04)',
  cursor: 'pointer',
  borderRadius: '12px',
  lineHeight: 0,
  overflow: 'hidden',
  transition: 'border-color 140ms ease',
  selectors: {
    '&:hover': {
      borderColor: 'rgba(255, 255, 255, 0.2)',
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

export const cardFadeOverlay = style([
  fadeOverlayBottom,
  {
    pointerEvents: 'none',
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: '32px',
    borderBottomLeftRadius: '18px',
    borderBottomRightRadius: '18px',
  },
]);

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
