import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const card = style({
  height: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusLg,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  background: vars.bg2,
  color: vars.fgBody,
});
export const header = style({
  height: 44,
  flexShrink: 0,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: '0.8rem',
});
export const title = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
export const action = style({
  cursor: 'pointer',
  color: vars.fgBody,
  background: 'transparent',
  border: `1px solid ${vars.border}`,
  borderRadius: 6,
  padding: '4px 8px',
  font: 'inherit',
  textDecoration: 'none',
});
export const content = style({
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 8,
  boxSizing: 'border-box',
});
export const status = style({
  color: vars.fgMuted,
  fontSize: '0.8rem',
  padding: 16,
  textAlign: 'center',
});
