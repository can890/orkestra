import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const card = style({
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusLg,
  overflow: 'hidden',
  background: vars.bg2,
  color: vars.fgBody,
});
export const header = style({
  height: 28,
  boxSizing: 'border-box',
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.75rem',
  color: vars.fgMuted,
  borderBottom: `1px solid ${vars.border}`,
});
export const title = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
export const frame = style({
  display: 'block',
  width: '100%',
  border: 0,
  background: 'transparent',
});
export const probe = style({ display: 'none' });
