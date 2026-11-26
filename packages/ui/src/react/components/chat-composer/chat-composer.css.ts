import { createContainer, globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { svgContainer } from '@styles/effects/svg-helpers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const composerRoot = style({
  display: 'flex',
  flexDirection: 'column',
});

export const noticeBand = recipe({
  base: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    borderRadius: `${tokenVars.radiusXl} ${tokenVars.radiusXl} 0 0`,
    border: '1px solid',
    borderBottomWidth: 0,
    paddingLeft: '0.75rem',
    paddingRight: '0.75rem',
    paddingTop: '0.5rem',
    paddingBottom: '0.5rem',
    fontSize: tokenVars.textXs,
  },
  variants: {
    variant: {
      error: {
        backgroundColor: vars.surfaceDestructive,
        borderColor: vars.surfaceDestructiveBorder,
        color: vars.surfaceDestructiveForeground,
      },
      warning: {
        backgroundColor: vars.surfaceWarning,
        borderColor: vars.surfaceWarningBorder,
        color: vars.surfaceWarningForeground,
      },
      info: {
        backgroundColor: vars.surfaceInfo,
        borderColor: vars.surfaceInfoBorder,
        color: vars.surfaceInfoForeground,
      },
    },
  },
  defaultVariants: { variant: 'info' },
});

export const noticeBandBody = style({ flex: 1 });

export const noticeBandHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
});

export const noticeBandTitle = style({
  fontSize: tokenVars.textSm,
  lineHeight: 1.375,
});

export const noticeBandMessage = style({ lineHeight: 1.375 });

export const noticeBandMessageIndented = style({
  marginTop: '0.25rem',
  opacity: 0.8,
});

export const noticeDismiss = style({
  marginLeft: '0.25rem',
  flexShrink: 0,
  opacity: 0.7,
  transition: 'opacity 150ms',
  selectors: {
    '&:hover': { opacity: 1 },
  },
});

export const noticeAnimWrapper = style({
  display: 'grid',
  transition: 'grid-template-rows 200ms ease-out, opacity 200ms ease-out',
});

export const noticeAnimVisible = style({ gridTemplateRows: '1fr', opacity: 1 });
export const noticeAnimHidden = style({ gridTemplateRows: '0fr', opacity: 0 });

export const noticeOverflowClip = style({ overflow: 'hidden' });

// ── Composer shell (Claude tarzı yuvarlatılmış, hafif yükseltilmiş giriş kutusu) ─

export const composerShell = recipe({
  base: {
    // Host-overridable via `--composer-bg`; defaults to the elevated surface.
    backgroundColor: `var(--composer-bg, ${vars.surfaceBaseEmphasis})`,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    border: `1px solid ${vars.border}`,
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
    transition: 'border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease',
    selectors: {
      '&:hover': { borderColor: vars.border1 },
      '&:focus-within': {
        borderColor: vars.border1,
      },
    },
  },
  variants: {
    hasBand: {
      true: { borderRadius: '0 0 1rem 1rem' },
      false: { borderRadius: '1rem' },
    },
    dragActive: {
      true: {
        borderColor: vars.border1,
        boxShadow: `0 0 0 1px ${vars.border1}`,
      },
      false: {},
    },
  },
  defaultVariants: { hasBand: false, dragActive: false },
});

// ── Header slot ───────────────────────────────────────────────────────────────

export const headerSlot = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.5rem',
  selectors: {
    '&:empty': { display: 'none' },
  },
});

// ── Image attachments ─────────────────────────────────────────────────────────

export const attachmentStrip = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.375rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.625rem',
  paddingBottom: '0.125rem',
});

export const visualAttachment = style({
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: '100%',
});

export const attachmentThumb = style({
  position: 'relative',
  width: '3.5rem',
  height: '3.5rem',
  flexShrink: 0,
});

export const attachmentFileChip = style({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  height: '2.25rem',
  maxWidth: '11.5rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.625rem',
  borderRadius: '10px',
  backgroundColor: 'color-mix(in srgb, currentColor 6%, transparent)',
  border: `1px solid ${vars.border}`,
  color: vars.foreground,
  fontSize: '0.75rem',
  flexShrink: 0,
});

export const attachmentFileName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const attachmentThumbBtn = style({
  position: 'relative',
  display: 'block',
  width: '3rem',
  height: '3rem',
  padding: 0,
  borderRadius: '10px',
  overflow: 'hidden',
  cursor: 'pointer',
  selectors: {
    '&:focus-visible': { outlineWidth: 2, outlineOffset: 1 },
  },
});

export const attachmentThumbImg = style({
  display: 'block',
  width: '3rem',
  height: '3rem',
  borderRadius: '10px',
  objectFit: 'cover',
});

export const attachmentVideoBadge = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(0, 0, 0, 0.28)',
  color: '#ffffff',
  pointerEvents: 'none',
});

export const attachmentRemoveBtn = style({
  position: 'absolute',
  top: '-0.35rem',
  right: '-0.35rem',
  zIndex: 2,
  display: 'grid',
  placeItems: 'center',
  width: '1rem',
  height: '1rem',
  borderRadius: '9999px',
  backgroundColor: vars.surface,
  color: vars.foreground,
  opacity: 0,
  boxShadow: `0 0 0 1px ${vars.border}`,
  transition: 'opacity 150ms',
  selectors: {
    // Show on hover of parent thumb or file chip
    '[data-attachment-thumb]:hover &': { opacity: 1 },
  },
});

// ── Input row & editor area (sol +, orta yazı alanı, sağ mikrofon + durdur/gönder) ─

export const inputRow = style({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '0.5rem',
  minHeight: '3rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.4375rem',
  paddingBottom: '0.4375rem',
});

export const inputLeading = style({
  display: 'flex',
  alignItems: 'center',
  flexShrink: 0,
  minHeight: '2rem',
});

export const attachPlusBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '2rem',
  height: '2rem',
  padding: 0,
  borderRadius: '0.5rem',
  border: 'none',
  background: 'transparent',
  color: vars.foregroundMuted,
  cursor: 'pointer',
  outline: 'none',
  transition: 'color 140ms ease, background-color 140ms ease',
  selectors: {
    '&:hover:not(:disabled)': {
      color: vars.foreground,
      backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)',
    },
    '&:focus-visible': {
      outline: `2px solid ${vars.borderPrimary}`,
      outlineOffset: '1px',
      color: vars.foreground,
    },
    '&:disabled': {
      opacity: 0.45,
      cursor: 'not-allowed',
    },
  },
});

export const editorWrap = style({
  flex: '1 1 auto',
  minWidth: 0,
  alignSelf: 'center',
});

export const editorArea = style({
  maxHeight: '200px',
  overflowY: 'auto',
  paddingLeft: '0.125rem',
  paddingRight: '0.125rem',
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
});

export const editorAreaNoLeading = style({
  paddingLeft: '0.375rem',
});

export const inputTrailing = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  flexShrink: 0,
  minHeight: '2rem',
});

// ── Footer meta bar (kutunun altında: sol araçlar · sağ Claude seçici dizilimi) ──

/**
 * The meta bar sits directly below the composer input shell (Claude desktop style).
 * It is a size container so in a narrow split pane labels shrink gracefully without overflow.
 */
const toolbarContainer = createContainer();

export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  minWidth: 0,
  paddingLeft: '0.375rem',
  paddingRight: '0.25rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.125rem',
  containerType: 'inline-size',
  containerName: toolbarContainer,
});

// Below `compact` the mode labels compact cleanly; below `tight` non-essential badges step aside.
const compact = `${toolbarContainer} (max-width: 28rem)`;
const tight = `${toolbarContainer} (max-width: 20rem)`;

export const metaLeft = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  minHeight: '1.625rem',
  flexShrink: 0,
  color: vars.foregroundMuted,
});

export const toolbarLeft = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.375rem',
  minHeight: '1.625rem',
  minWidth: 0,
  marginLeft: 'auto',
  flex: '1 1 auto',
  '@container': {
    [compact]: { gap: '0.25rem' },
    [tight]: { gap: '0.125rem', overflow: 'hidden' },
  },
});

// Every selector in the meta bar may shrink; its label truncates cleanly if pane is very narrow.
globalStyle(`${toolbarLeft} > *`, { minWidth: 0 });

/** Mode selector trigger (collaboration / permission): Claude-style clean inline meta trigger. */
export const modeTrigger = style({
  height: '1.5rem',
  paddingLeft: '0.375rem',
  paddingRight: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  border: 'none',
  background: 'transparent',
  color: vars.foreground,
  selectors: {
    [`${toolbarLeft} > &`]: { flex: '0 1 auto', minWidth: 0, maxWidth: '100%' },
    '&:hover:not(:disabled)': {
      backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)',
    },
  },
  '@container': {
    [compact]: {
      selectors: {
        [`${toolbarLeft} > &`]: {
          flexShrink: 1,
          gap: '0.125rem',
          paddingLeft: '0.25rem',
          paddingRight: '0.25rem',
        },
      },
    },
    [tight]: {
      selectors: {
        [`${toolbarLeft} > &`]: { paddingLeft: '0.25rem', paddingRight: '0.25rem' },
      },
    },
  },
});

/** Claude tarzı kip hapı (CVP / Plan / Standart rozeti). */
export const modeTriggerPill = style({
  height: '1.375rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  borderRadius: '9999px',
  backgroundColor: 'color-mix(in srgb, currentColor 9%, transparent)',
  color: vars.foregroundMuted,
  selectors: {
    '&:hover:not(:disabled)': {
      backgroundColor: 'color-mix(in srgb, currentColor 14%, transparent)',
      color: vars.foreground,
    },
  },
});

/** Claude tarzı sade izin metin tetikleyicisi ("İzinleri atla" / "Otomatik onay"). */
export const modeTriggerQuiet = style({
  height: '1.5rem',
  paddingLeft: '0.375rem',
  paddingRight: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  color: vars.foreground,
});

// Hide trailing Select chevron inside Claude-style quiet/pill mode triggers for clean typography.
globalStyle(`${toolbarLeft} > ${modeTrigger} > svg`, {
  display: 'none',
});

export const modeLabel = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  minWidth: 0,
  overflow: 'hidden',
  fontSize: '0.75rem',
  fontWeight: 450,
  lineHeight: 1.25,
});

export const modeLabelPill = style({
  fontSize: '0.6875rem',
  fontWeight: 500,
  letterSpacing: '0.01em',
});

export const modeLabelText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const mcpNameGroup = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  minWidth: 0,
});

export const mcpInfoIcon = style({
  transform: 'translateY(1px)',
});

export const mcpErrorText = style({
  minWidth: 0,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
});
export const toolbarRight = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  flexShrink: 0,
});

export const permissionModeTrigger = style({
  paddingLeft: '0.375rem',
  paddingRight: '0.375rem',
});

export const selectedModelEffort = style({
  color: vars.foregroundMuted,
});

export const mcpTrigger = style([
  svgContainer,
  {
    display: 'inline-flex',
    flexShrink: 0,
    height: '1.625rem',
    alignItems: 'center',
    gap: '0.25rem',
    borderRadius: tokenVars.radiusMd,
    paddingLeft: '0.375rem',
    paddingRight: '0.375rem',
    color: vars.foregroundMuted,
    fontSize: tokenVars.textXs,
    lineHeight: 1,
    outline: 'none',
    transition: 'color 140ms ease, background-color 140ms ease',
    '@container': {
      [tight]: { display: 'none' },
    },
    selectors: {
      '&[data-failed]': { color: vars.surfaceDestructiveForeground },
      '&:hover': {
        color: vars.foreground,
        backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)',
      },
      '&[data-popup-open]': {
        color: vars.foreground,
        backgroundColor: 'color-mix(in srgb, currentColor 10%, transparent)',
      },
    },
  },
]);

export const mcpPopoverContent = style({
  width: '16rem',
  padding: '0.5rem',
});

export const mcpList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
});

export const mcpRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  borderRadius: tokenVars.radiusMd,
  padding: '0.375rem 0.5rem',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
  selectors: {
    '&[data-failed]': { color: vars.surfaceDestructiveForeground },
  },
});

export const mcpName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const mcpBadge = style({
  flexShrink: 0,
  borderRadius: tokenVars.radiusSm,
  border: `1px solid ${vars.border}`,
  padding: '0.0625rem 0.3125rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
  selectors: {
    '&[data-failed]': { color: vars.surfaceDestructiveForeground },
  },
});

// ── Agent trigger ─────────────────────────────────────────────────────────────

export const agentTrigger = style({
  display: 'flex',
  flexShrink: 0,
  width: '1.75rem',
  height: '1.75rem',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  color: vars.foreground,
  outline: 'none',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceBaseSelected },
    '&[data-popup-open]': { backgroundColor: vars.surfaceBaseSelected },
  },
});

/** Small status chip on an agent row (e.g. "limit doldu"). Never hides or disables the row. */
export const agentBadge = recipe({
  base: {
    flexShrink: 0,
    borderRadius: tokenVars.radiusSm,
    border: '1px solid',
    paddingLeft: '0.375rem',
    paddingRight: '0.375rem',
    fontSize: tokenVars.textXs,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  },
  variants: {
    tone: {
      muted: {
        backgroundColor: 'transparent',
        borderColor: vars.border,
        color: vars.foregroundMuted,
      },
      warning: {
        backgroundColor: vars.surfaceWarning,
        borderColor: vars.surfaceWarningBorder,
        color: vars.surfaceWarningForeground,
      },
      danger: {
        backgroundColor: vars.surfaceDestructive,
        borderColor: vars.surfaceDestructiveBorder,
        color: vars.surfaceDestructiveForeground,
      },
    },
  },
  defaultVariants: { tone: 'muted' },
});

export const agentIconPlaceholder = style({
  width: '1rem',
  height: '1rem',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.border,
});

// ── Model detail card ─────────────────────────────────────────────────────────

export const modelDetailCard = style({
  width: '14rem',
  padding: '0.75rem',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
});

export const modelDetailName = style({
  lineHeight: 1.25,
  fontWeight: 400,
});

export const modelDetailDesc = style({
  marginTop: '0.25rem',
  fontSize: tokenVars.textXs,
  lineHeight: 1.375,
  color: vars.foregroundMuted,
});

export const modelDetailFeatures = style({
  marginTop: '0.5rem',
  borderTop: `1px solid ${vars.border}`,
  paddingTop: '0.5rem',
});

export const modelDetailRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  fontSize: tokenVars.textXs,
});

export const modelDetailLabel = style({ color: vars.foregroundMuted });
export const modelDetailValue = style({ color: vars.foreground });

export const barMeter = style({ display: 'flex', alignItems: 'center', gap: '0.125rem' });

/** Send button override — Claude tarzı yumuşak yuvarlak düğme. */
export const sendButtonRound = style({
  width: '1.875rem',
  height: '1.875rem',
  borderRadius: '0.625rem',
  transition: 'opacity 140ms ease, background-color 140ms ease, transform 120ms ease',
});

/** Boşken gözü yormayan sakin gönder düğmesi; içerik girilince canlı vurguya döner. */
export const sendButtonIdle = style({
  opacity: 0.32,
  selectors: {
    '&:hover:not(:disabled)': {
      opacity: 0.72,
    },
  },
});

/** Claude tarzı kare durdur düğmesi (Görsel 2: koyu yuvarlatılmış kare içinde net beyaz kare). */
export const stopButtonSquare = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.875rem',
  height: '1.875rem',
  padding: 0,
  borderRadius: '0.5rem',
  border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  backgroundColor: 'color-mix(in srgb, currentColor 11%, transparent)',
  color: vars.foreground,
  cursor: 'pointer',
  outline: 'none',
  transition: 'background-color 140ms ease, border-color 140ms ease',
  selectors: {
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)',
      borderColor: 'color-mix(in srgb, currentColor 20%, transparent)',
    },
    '&:focus-visible': {
      outline: `2px solid ${vars.borderPrimary}`,
      outlineOffset: '1px',
    },
  },
});

export const stopIcon = style({
  width: '0.625rem',
  height: '0.625rem',
  borderRadius: '0.125rem',
  backgroundColor: 'currentColor',
});

export const stopTooltipRow = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: tokenVars.textXs,
});

export const stopTooltipKey = style({
  color: vars.foregroundMuted,
  fontSize: '0.6875rem',
});

// ── Context usage indicator ────────────────────────────────────────────────────

/** Donut SVG container — sized to match Claude's clean circular ring in bottom-right meta bar. */
export const donut = style({
  width: '0.9375rem',
  height: '0.9375rem',
  display: 'block',
  overflow: 'visible',
});

/** Background track ring. */
export const donutTrack = style({
  stroke: 'color-mix(in srgb, currentColor 18%, transparent)',
});

/** Foreground fill ring — Claude-style calm blue progress ring. */
export const donutProgress = style({ stroke: vars.foregroundInfo });

/** Foreground fill ring — warning state (>= 90% full). */
export const donutProgressWarn = style({ stroke: vars.surfaceWarningForeground });

/** Cost row shown below the description in the popover when cost is available. */
export const usageCostRow = style({
  marginTop: '0.625rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const usageCompactAction = style({
  marginTop: '0.625rem',
  paddingTop: '0.5rem',
  borderTop: `1px solid ${vars.border}`,
});

export const usageCompactButton = style({
  width: '100%',
  justifyContent: 'center',
});

export const usagePopoverBody = style({
  width: '16rem',
});

export const usageStatsRow = style({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '1rem',
  fontSize: tokenVars.textXs,
});

export const usagePercent = style({
  fontWeight: 400,
  color: vars.foreground,
});

export const usageTokenCount = style({
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
});

export const usageBarTrack = style({
  marginTop: '0.5rem',
  height: '0.375rem',
  overflow: 'hidden',
  borderRadius: '9999px',
  backgroundColor: vars.border,
});

export const usageBarFill = style({
  height: '100%',
  borderRadius: '9999px',
  backgroundColor: vars.foreground,
});

export const usageBarFillWarn = style({
  backgroundColor: vars.surfaceWarningForeground,
});

export const barDotFilled = style({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '9999px',
  background: vars.foregroundMuted,
});

export const barDotEmpty = style({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '9999px',
  background: vars.border,
});

// ── Effort row (footer inside the model popover) ───────────────────────────────

/**
 * Full-width row rendered in the model popover footer that acts as the trigger
 * for the effort/thought-level submenu flyout.
 */
export const effortRow = style({
  display: 'flex',
  width: '100%',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  fontSize: tokenVars.textSm,
  color: vars.foreground,
  background: 'transparent',
  border: 'none',
  cursor: 'default',
  outline: 'none',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
    '&[data-popup-open]': { backgroundColor: vars.surfaceHover },
  },
});

export const effortRowLabel = style({
  color: vars.foreground,
});

export const effortRowValue = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textXs,
});
