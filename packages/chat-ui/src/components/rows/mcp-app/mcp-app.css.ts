import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const row = style({
  boxSizing: 'border-box',
  paddingTop: 8,
  paddingBottom: 8,
});

export const card = style({
  position: 'relative',
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusLg,
  overflow: 'hidden',
  background: vars.bg2,
  color: vars.fgBody,
  display: 'flex',
  flexDirection: 'column',
});

/** Full screen: the card is a manual popover in the top layer, so no ancestor can clip it. */
export const fullscreen = style({
  position: 'fixed',
  inset: 0,
  width: '100vw',
  height: '100vh',
  maxWidth: 'none',
  maxHeight: 'none',
  margin: 0,
  padding: 0,
  border: 0,
  borderRadius: 0,
  background: vars.bg,
});

globalStyle(`${fullscreen}::backdrop`, { background: 'rgba(0, 0, 0, 0.4)' });

export const header = style({
  height: 28,
  flex: '0 0 auto',
  boxSizing: 'border-box',
  padding: '0 8px 0 12px',
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

export const badge = style({
  padding: '0 6px',
  borderRadius: vars.radiusSm,
  border: `1px solid ${vars.border}`,
  fontSize: '0.6875rem',
});

export const headerButton = style({
  border: 0,
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  fontSize: '0.75rem',
  padding: '2px 6px',
  borderRadius: vars.radiusSm,
  selectors: { '&:hover': { background: vars.bg3, color: vars.fg } },
});

export const frame = style({
  display: 'block',
  width: '100%',
  border: 0,
  background: 'transparent',
  flex: '1 1 auto',
});

export const notice = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 12,
  fontSize: '0.75rem',
  color: vars.fgMuted,
  flex: '1 1 auto',
});

export const consent = style({
  position: 'absolute',
  top: 28,
  left: 0,
  right: 0,
  bottom: 0,
  boxSizing: 'border-box',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: vars.bg1,
  color: vars.fg,
  fontSize: '0.8125rem',
  zIndex: 1,
});

export const consentDetail = style({
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'auto',
  margin: 0,
  padding: 8,
  borderRadius: vars.radiusSm,
  background: vars.bg,
  fontFamily: vars.fontMono,
  fontSize: '0.75rem',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});

export const consentActions = style({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
});

export const button = style({
  border: `1px solid ${vars.border}`,
  background: vars.bg2,
  color: vars.fg,
  borderRadius: vars.radiusSm,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: '0.8125rem',
});

export const primaryButton = style([
  button,
  { background: vars.link, borderColor: vars.link, color: '#ffffff' },
]);

export const probe = style({ display: 'none' });
