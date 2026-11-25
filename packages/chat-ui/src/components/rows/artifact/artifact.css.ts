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
  height: 52,
  maxWidth: 460,
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

// ── Streamed video / audio cards ────────────────────────────────────────────
// No continuous animations; only short hover colour transitions.

export const videoCard = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  margin: 0,
  padding: 0,
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: 12,
  overflow: 'hidden',
  background: vars.bg1,
  transition: 'border-color 140ms ease',
  selectors: {
    '&:hover, &:focus-within': {
      borderColor: 'rgba(255, 255, 255, 0.18)',
    },
  },
});

export const videoFrame = style({
  position: 'relative',
  width: '100%',
  flexShrink: 0,
  background: '#000',
  overflow: 'hidden',
});

export const videoFrameEl = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
  colorScheme: 'dark',
  outline: 'none',
});

export const videoFrameOverlay = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 12,
  color: 'rgba(244, 244, 245, 0.78)',
  fontSize: '12px',
  textAlign: 'center',
  background: 'radial-gradient(ellipse at center, rgba(40, 42, 48, 0.9), rgba(8, 8, 10, 0.96))',
  pointerEvents: 'none',
});

export const videoFrameOverlayInteractive = style({
  pointerEvents: 'auto',
});

export const videoOverlayPlay = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.12)',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  color: '#f4f4f5',
});

export const videoMetaRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '0 6px 0 10px',
  boxSizing: 'border-box',
  color: vars.fgBody,
  fontSize: '12px',
});

export const videoMetaText = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

export const videoMetaName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontWeight: 500,
  color: vars.fg,
});

export const videoMetaDetail = style({
  flexShrink: 0,
  color: vars.fgMuted,
  fontSize: '11px',
  fontVariantNumeric: 'tabular-nums',
});

export const videoMetaActions = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 0,
  flexShrink: 0,
});

export const videoTileOpen = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  padding: 0,
  margin: 0,
  background: 'transparent',
  cursor: 'pointer',
  selectors: {
    '&:focus-visible': {
      outline: '2px solid rgba(255, 255, 255, 0.7)',
      outlineOffset: -2,
    },
  },
});

export const audioMeta = style({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 2,
  minWidth: 0,
  maxWidth: 180,
  flexShrink: 1,
});

export const audioMetaName = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '12px',
  fontWeight: 500,
  color: vars.fg,
});

export const audioMetaDetail = style({
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  fontSize: '11px',
  color: vars.fgMuted,
  fontVariantNumeric: 'tabular-nums',
});

export const audioPlayer = style({
  flex: 1,
  minWidth: 120,
  height: 32,
});
