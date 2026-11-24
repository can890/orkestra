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
  alignItems: 'flex-start',
  justifyContent: 'flex-start',
  minWidth: 32,
  minHeight: 28,
  maxWidth: '100%',
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  borderRadius: 10,
  overflow: 'hidden',
});

export const galleryMediaSection = style({
  position: 'relative',
  width: 144,
  height: 108,
  flexShrink: 0,
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'rgba(15, 17, 21, 0.25)',
  borderRadius: 10,
  overflow: 'hidden',
});

export const singleImageEl = style({
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: 280,
  maxHeight: 180,
  objectFit: 'contain',
  borderRadius: 10,
  cursor: 'zoom-in',
});

export const singleVideoWrap = style({
  position: 'relative',
  width: 260,
  height: 160,
  borderRadius: 10,
  overflow: 'hidden',
  background: 'rgba(15, 17, 21, 0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const singleVideoEl = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  borderRadius: 10,
});

export const galleryMediaImg = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  cursor: 'zoom-in',
});

export const galleryMediaVideo = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  cursor: 'pointer',
});

export const hoverOverlay = style({
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 3,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  borderRadius: 999,
  background: 'rgba(15, 17, 21, 0.72)',
  backdropFilter: 'blur(10px)',
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

export const glassActionBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 22,
  padding: '0 7px',
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: '#f4f4f5',
  fontSize: '11px',
  fontWeight: 500,
  lineHeight: 1,
  textDecoration: 'none',
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      background: 'rgba(255, 255, 255, 0.16)',
    },
    '&:focus-visible': {
      outline: '2px solid rgba(255, 255, 255, 0.7)',
      outlineOffset: 1,
    },
  },
});

export const videoPlayTrigger = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid rgba(255, 255, 255, 0.18)',
  background: 'rgba(15, 17, 21, 0.78)',
  color: '#f4f4f5',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      background: 'rgba(25, 28, 36, 0.9)',
    },
  },
});

export const videoPlayBadge = style({
  position: 'absolute',
  left: 6,
  bottom: 6,
  zIndex: 2,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 999,
  background: 'rgba(15, 17, 21, 0.72)',
  color: '#f4f4f5',
  border: '1px solid rgba(255, 255, 255, 0.16)',
  pointerEvents: 'none',
});

export const videoExpandCorner = style({
  position: 'absolute',
  top: 6,
  left: 6,
  zIndex: 3,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 999,
  border: '1px solid rgba(255, 255, 255, 0.14)',
  background: 'rgba(15, 17, 21, 0.72)',
  backdropFilter: 'blur(10px)',
  color: '#f4f4f5',
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 140ms ease',
  selectors: {
    [`${singleMediaSection}:hover &, ${singleMediaSection}:focus-within &`]: {
      opacity: 1,
    },
    [`${galleryMediaSection}:hover &, ${galleryMediaSection}:focus-within &`]: {
      opacity: 1,
    },
    '&:hover': {
      background: 'rgba(255, 255, 255, 0.18)',
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
  height: 44,
  maxWidth: 420,
  padding: '0 10px',
  borderRadius: 10,
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
