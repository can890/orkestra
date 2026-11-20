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

export const menuContent = style({
  minWidth: '17rem',
  maxWidth: '23rem',
  maxHeight: '22rem',
});

export const subMenuContent = style({
  minWidth: '9.5rem',
  maxWidth: '16rem',
});

export const rowActive = style({
  backgroundColor: vars.surfaceSelected,
  color: vars.foreground,
});

export const rowLabelGroup = style({
  display: 'inline-flex',
  minWidth: 0,
  flex: 1,
  alignItems: 'baseline',
  gap: '0.4rem',
  overflow: 'hidden',
});

export const rowModelName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: vars.foreground,
});

export const rowEffortHint = style({
  flexShrink: 0,
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
});

export const standaloneItem = style({
  paddingRight: '2rem',
});

export const standaloneCheck = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foreground,
});
