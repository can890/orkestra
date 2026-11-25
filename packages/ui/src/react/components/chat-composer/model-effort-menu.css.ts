import { style } from '@vanilla-extract/css';
import { fieldShellBase } from '@styles/recipes/field-shell.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const triggerControl = style({
  display: 'inline-flex',
  height: '1.75rem',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  fontSize: tokenVars.textXs,
  color: vars.foreground,
  background: 'transparent',
  outline: 'none',
  cursor: 'pointer',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceBaseSelected },
    '&[data-popup-open]': { backgroundColor: vars.surfaceBaseSelected },
    '&[data-disabled], &:disabled': { cursor: 'not-allowed', opacity: 0.6 },
  },
});

export const triggerInput = [
  fieldShellBase,
  style({
    display: 'flex',
    width: '100%',
    height: '2rem',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.375rem',
    paddingLeft: '0.625rem',
    paddingRight: '0.5rem',
    fontSize: tokenVars.textSm,
    color: vars.foreground,
    cursor: 'pointer',
    selectors: {
      '&[data-disabled], &:disabled': { cursor: 'not-allowed', opacity: 0.6 },
    },
  }),
] as const;

export const triggerContent = style({
  display: 'inline-flex',
  minWidth: 0,
  flex: 1,
  alignItems: 'center',
  gap: '0.375rem',
  overflow: 'hidden',
  lineHeight: 1.25,
  textAlign: 'left',
});

export const triggerText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.25,
});

export const triggerEffort = style({
  color: vars.foregroundMuted,
  fontWeight: 400,
});

export const triggerChevron = style({
  flexShrink: 0,
  width: '0.75rem',
  height: '0.75rem',
  color: vars.foregroundMuted,
});

// ── T3 3-Column Picker Surface ────────────────────────────────────────────────

export const popoverSurface = style({
  padding: 0,
  gap: 0,
  borderRadius: '0.75rem',
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surface,
  boxShadow: vars.shadowLg,
  overflow: 'hidden',
});

export const pickerRoot = style({
  display: 'flex',
  flexDirection: 'column',
  width: 'min(36rem, calc(100vw - 1.5rem))',
  maxWidth: '100%',
  overflow: 'hidden',
});

export const pickerRootWide = style({
  width: 'min(42rem, calc(100vw - 1.5rem))',
});

export const pickerRootCompact = style({
  width: 'min(31rem, calc(100vw - 1.5rem))',
});

export const pickerRootCompactWide = style({
  width: 'min(37rem, calc(100vw - 1.5rem))',
});

export const pickerBody = style({
  display: 'flex',
  flexDirection: 'row',
  height: '21.5rem',
  minHeight: '15.5rem',
  maxHeight: '23rem',
  overflow: 'hidden',
});

// ── Column 1: Provider Rail ───────────────────────────────────────────────────

export const providerRail = style({
  width: '2.75rem',
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.375rem 0.25rem',
  backgroundColor: vars.surfaceBase,
  borderRight: `1px solid ${vars.border}`,
  overflowY: 'auto',
});

export const railItemWrap = style({
  position: 'relative',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const railButton = style({
  position: 'relative',
  width: '2.25rem',
  height: '2.25rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusMd,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  cursor: 'pointer',
  outline: 'none',
  transition: 'background-color 120ms ease, color 120ms ease',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceBaseHover,
      color: vars.foreground,
    },
    '&[data-active="true"]': {
      backgroundColor: vars.surfaceBaseSelected,
      color: vars.foreground,
    },
    '&:disabled': {
      opacity: 0.45,
      cursor: 'not-allowed',
    },
  },
});

export const railActiveBar = style({
  position: 'absolute',
  right: '-0.25rem',
  top: '50%',
  transform: 'translateY(-50%)',
  width: '3px',
  height: '1.25rem',
  borderRadius: '9999px',
  backgroundColor: '#3b82f6',
  pointerEvents: 'none',
});

export const railDivider = style({
  width: '1.5rem',
  height: '1px',
  backgroundColor: vars.border,
  margin: '0.125rem 0',
  flexShrink: 0,
});

export const railBadgeDot = style({
  position: 'absolute',
  right: '0.25rem',
  bottom: '0.25rem',
  width: '0.4375rem',
  height: '0.4375rem',
  borderRadius: '9999px',
  border: `1px solid ${vars.surfaceBase}`,
  pointerEvents: 'none',
});

export const railBadgeDotWarning = style({
  backgroundColor: '#f59e0b',
});

export const railBadgeDotDanger = style({
  backgroundColor: '#ef4444',
});

// ── Column 2: Search + Model List ─────────────────────────────────────────────

export const modelColumn = style({
  flex: '1 1 0%',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

export const searchBar = style({
  height: '2.5rem',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0 0.75rem',
  borderBottom: `1px solid ${vars.border}`,
  color: vars.foregroundMuted,
  selectors: {
    '&:focus-within': {
      boxShadow: 'inset 0 -2px 0 0 #3b82f6',
    },
  },
});

export const searchInput = style({
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  outline: 'none',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
  selectors: {
    '&::placeholder': {
      color: vars.foregroundPassive,
    },
  },
});

export const searchClearBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.25rem',
  height: '1.25rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceHover,
      color: vars.foreground,
    },
  },
});

export const modelList = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0.375rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
});

export const modelRow = style({
  position: 'relative',
  width: '100%',
  minHeight: '2.125rem',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  paddingRight: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: 'transparent',
  transition: 'background-color 90ms ease',
  selectors: {
    '&:hover, &[data-highlighted="true"]': {
      backgroundColor: vars.surfaceHover,
    },
    '&[data-selected="true"]': {
      backgroundColor: vars.surfaceSelected,
    },
    // İşaretlenmiş (henüz "Tamam" ile onaylanmamış) satır.
    '&[data-pending="true"]': {
      backgroundColor: vars.surfaceSelected,
      boxShadow: `inset 0 0 0 1px ${vars.primaryButtonBackground}`,
    },
  },
});

export const modelRowBtn = style({
  flex: '1 1 0%',
  minWidth: 0,
  minHeight: '2.125rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.375rem 0.25rem 0.375rem 0.5rem',
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foreground,
  fontSize: tokenVars.textSm,
  textAlign: 'left',
  cursor: 'pointer',
  outline: 'none',
});

export const modelRowIcon = style({
  flexShrink: 0,
  width: '1rem',
  height: '1rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foregroundMuted,
});

export const modelRowName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.foreground,
});

export const modelRowCheck = style({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  color: vars.foregroundMuted,
});

export const modelRowRight = style({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
});

export const favoriteStarBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.25rem',
  height: '1.25rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 100ms ease, color 100ms ease',
  selectors: {
    [`${modelRow}:hover &, ${modelRow}[data-pending="true"] &, &[data-favorited="true"]`]: {
      opacity: 1,
    },
    '&[data-favorited="true"]': {
      color: '#f59e0b',
    },
    '&:hover': {
      color: vars.foreground,
    },
  },
});

export const shortcutPill = style({
  flexShrink: 0,
  fontSize: '0.6875rem',
  lineHeight: 1.2,
  color: vars.foregroundMuted,
  backgroundColor: 'rgba(128, 128, 128, 0.14)',
  border: `1px solid ${vars.border}`,
  borderRadius: '0.25rem',
  padding: '0.125rem 0.3125rem',
  fontVariantNumeric: 'tabular-nums',
});

export const showMoreBtn = style({
  width: '100%',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  padding: '0.45rem 0.625rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
  textAlign: 'left',
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceHover,
      color: vars.foreground,
    },
  },
});

export const emptyStateText = style({
  padding: '1.25rem 0.75rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
  textAlign: 'center',
  lineHeight: 1.45,
});

// ── Column 3: Reasoning / Effort Panel ────────────────────────────────────────

export const effortColumn = style({
  width: '11.75rem',
  flexShrink: 0,
  borderLeft: `1px solid ${vars.border}`,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
});

export const effortColumnWide = style({
  width: '17rem',
});

export const effortHeader = style({
  height: '2.5rem',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0 0.75rem',
  borderBottom: `1px solid ${vars.border}`,
  fontSize: tokenVars.textXs,
});

export const effortHeaderTitle = style({
  color: vars.foregroundMuted,
  fontWeight: 500,
  flexShrink: 0,
});

export const effortHeaderModel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.foregroundPassive,
  fontSize: tokenVars.textXs,
  textAlign: 'right',
});

export const effortList = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0.375rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
});

export const effortRow = style({
  width: '100%',
  height: '2.125rem',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0 0.5rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foreground,
  fontSize: tokenVars.textSm,
  textAlign: 'left',
  cursor: 'pointer',
  outline: 'none',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceHover,
    },
    '&[data-selected="true"]': {
      backgroundColor: vars.surfaceSelected,
    },
  },
});

export const effortDefaultTag = style({
  fontSize: tokenVars.textXs,
  color: vars.foregroundPassive,
});

// ── Bottom Footer Bar ─────────────────────────────────────────────────────────

export const footerBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.5rem 0.625rem',
  borderTop: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceBase,
});

export const footerLeft = style({
  display: 'flex',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.375rem',
});

export const segmentedGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: tokenVars.radiusMd,
  backgroundColor: vars.surface,
  border: `1px solid ${vars.border}`,
  padding: '0.125rem',
  gap: '0.125rem',
});

export const segmentedBtn = style({
  height: '1.5rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0 0.5rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textXs,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': {
      color: vars.foreground,
    },
    '&[data-active="true"]': {
      backgroundColor: vars.surfaceBaseSelected,
      color: vars.foreground,
      fontWeight: 500,
    },
  },
});

export const footerSwitchHint = style({
  display: 'inline-flex',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const footerPermissionBtn = style({
  marginLeft: 'auto',
  height: '1.625rem',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0 0.5rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textXs,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceHover,
      color: vars.foreground,
    },
  },
});

// ── Onay Çubuğu (Vazgeç / Tamam) ─────────────────────────────────────────────

export const confirmBar = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 0.625rem',
  borderTop: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceBase,
});

export const confirmSummary = style({
  flex: '1 1 0%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const cancelBtn = style({
  height: '1.75rem',
  padding: '0 0.75rem',
  borderRadius: tokenVars.radiusSm,
  border: `1px solid ${vars.border}`,
  backgroundColor: 'transparent',
  color: vars.foreground,
  fontSize: tokenVars.textXs,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
  },
});

export const confirmBtn = style({
  height: '1.75rem',
  padding: '0 0.875rem',
  borderRadius: tokenVars.radiusSm,
  border: `1px solid ${vars.primaryButtonBorder}`,
  backgroundColor: vars.primaryButtonBackground,
  color: vars.primaryButtonForeground,
  fontSize: tokenVars.textXs,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover:not(:disabled)': { backgroundColor: vars.primaryButtonBackgroundHover },
    '&:disabled': { cursor: 'not-allowed', opacity: 0.5 },
  },
});
