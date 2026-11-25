import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const groupRoot = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  boxSizing: 'border-box',
  width: '100%',
});

export const mediaStrip = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 8,
});

export const singleMediaSection = style({
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 168,
  minHeight: 112,
  maxWidth: 'min(280px, 100%)',
  maxHeight: 180,
  margin: 0,
  padding: 0,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  background: 'rgba(255, 255, 255, 0.04)',
  borderRadius: 12,
  overflow: 'hidden',
  transition: 'border-color 140ms ease',
  selectors: {
    '&:hover, &:focus-within': {
      borderColor: 'rgba(255, 255, 255, 0.18)',
    },
  },
});

export const galleryMediaSection = style({
  position: 'relative',
  width: 144,
  height: 108,
  flexShrink: 0,
  margin: 0,
  padding: 0,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  background: 'rgba(255, 255, 255, 0.04)',
  borderRadius: 12,
  overflow: 'hidden',
  transition: 'border-color 140ms ease',
  selectors: {
    '&:hover, &:focus-within': {
      borderColor: 'rgba(255, 255, 255, 0.18)',
    },
  },
});

export const singleImageEl = style({
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: '100%',
  maxHeight: 178,
  objectFit: 'contain',
  borderRadius: 11,
  cursor: 'zoom-in',
});

export const galleryMediaImg = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  cursor: 'zoom-in',
});

export const hoverOverlay = style({
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 3,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 1,
  padding: 2,
  borderRadius: 10,
  background: 'rgba(15, 17, 21, 0.62)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  opacity: 0,
  transition: 'opacity 140ms ease',
  pointerEvents: 'none',
  selectors: {
    [`${singleMediaSection}:hover &, ${singleMediaSection}:focus-within &`]: {
      opacity: 1,
      pointerEvents: 'auto',
    },
    [`${galleryMediaSection}:hover &, ${galleryMediaSection}:focus-within &`]: {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
});

export const mediaPlaceholder = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  minWidth: 160,
  minHeight: 84,
  padding: '8px 12px',
  borderRadius: 10,
  background: vars.bg2,
  color: vars.fgMuted,
  fontSize: '12px',
  textAlign: 'center',
  boxSizing: 'border-box',
});

export const audioSection = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: 460,
  padding: '0 10px',
  borderRadius: 14,
  background: vars.bg2,
  color: vars.fgBody,
  boxSizing: 'border-box',
  overflow: 'hidden',
});

export const fileList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

export const filePillSection = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  maxWidth: 'min(420px, 100%)',
  width: 'fit-content',
  padding: '0 10px',
  borderRadius: 10,
  background: vars.bg2,
  color: vars.fgBody,
  fontSize: '12px',
  boxSizing: 'border-box',
  overflow: 'hidden',
});

export const fileName = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
});

export const compactAction = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 24,
  padding: '0 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: vars.fgMuted,
  font: 'inherit',
  fontSize: '11px',
  fontWeight: 500,
  textDecoration: 'none',
  cursor: 'pointer',
  flexShrink: 0,
  selectors: {
    '&:hover': {
      color: vars.fg,
      background: 'rgba(128, 128, 128, 0.14)',
    },
  },
});

export const audioPlayer = style({
  flex: 1,
  minWidth: 120,
  height: 32,
});
