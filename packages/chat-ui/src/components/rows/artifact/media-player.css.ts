import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

// Video ve ses oynatıcısı. Sürekli çalışan animasyon yok: yalnızca kısa geçişler ve tampon
// beklenirken (geçici) dönen halka.

const ring = `inset 0 0 0 1px color-mix(in srgb, ${vars.fg} 11%, transparent)`;
const hoverTint = `color-mix(in srgb, ${vars.fg} 9%, transparent)`;

// ── Video kartı ───────────────────────────────────────────────────────────────

export const videoCard = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  margin: 0,
  padding: 0,
  boxSizing: 'border-box',
  borderRadius: 14,
  overflow: 'hidden',
  background: vars.bg1,
  selectors: {
    // Çerçeve çizgisi içeriğin üstünde durur; kartın ölçüsünü değiştirmez.
    '&::after': {
      content: '',
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      boxShadow: ring,
      pointerEvents: 'none',
    },
  },
});

export const frame = style({
  position: 'relative',
  width: '100%',
  flexShrink: 0,
  background: '#000',
  overflow: 'hidden',
  outline: 'none',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  selectors: {
    '&[data-idle="true"]': { cursor: 'none' },
    '&:focus-visible': { boxShadow: 'inset 0 0 0 2px rgba(255, 255, 255, 0.75)' },
    '&:fullscreen': { width: '100vw !important', height: '100vh !important' },
  },
});

export const videoEl = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
  outline: 'none',
});

export const placeholder = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  padding: '14px 18px',
  color: 'rgba(244, 244, 245, 0.8)',
  fontSize: '12px',
  lineHeight: 1.45,
  textAlign: 'center',
  background: 'radial-gradient(120% 130% at 50% 0%, #2a2b30 0%, #151517 55%, #0c0c0e 100%)',
  pointerEvents: 'none',
});

export const placeholderIcon = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'rgba(244, 244, 245, 0.85)',
});

export const glassPill = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 14px',
  borderRadius: 999,
  border: '1px solid rgba(255, 255, 255, 0.22)',
  background: 'rgba(18, 18, 20, 0.5)',
  backdropFilter: 'blur(14px) saturate(140%)',
  color: '#fff',
  font: 'inherit',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  pointerEvents: 'auto',
  selectors: {
    '&:hover': { background: 'rgba(40, 40, 44, 0.62)' },
  },
});

export const bigPlay = style({
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 58,
  height: 58,
  marginTop: -29,
  marginLeft: -29,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  border: '1px solid rgba(255, 255, 255, 0.24)',
  background: 'rgba(18, 18, 20, 0.46)',
  backdropFilter: 'blur(14px) saturate(140%)',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.38)',
  color: '#fff',
  cursor: 'pointer',
  transition: 'transform 160ms ease, background 160ms ease',
  selectors: {
    '&[data-compact="true"]': { width: 44, height: 44, marginTop: -22, marginLeft: -22 },
    [`${frame}:hover &`]: { transform: 'scale(1.07)', background: 'rgba(34, 34, 38, 0.6)' },
    '&:active': { transform: 'scale(0.95)' },
    '&:focus-visible': { outline: '2px solid rgba(255, 255, 255, 0.8)', outlineOffset: 2 },
  },
});

export const durationChip = style({
  position: 'absolute',
  right: 9,
  bottom: 9,
  padding: '3px 7px',
  borderRadius: 7,
  background: 'rgba(0, 0, 0, 0.62)',
  backdropFilter: 'blur(8px)',
  color: '#fff',
  fontSize: '11px',
  fontWeight: 500,
  lineHeight: '14px',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});

const spin = keyframes({ to: { transform: 'rotate(360deg)' } });

export const spinner = style({
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 30,
  height: 30,
  marginTop: -15,
  marginLeft: -15,
  borderRadius: 999,
  border: '2.5px solid rgba(255, 255, 255, 0.22)',
  borderTopColor: '#fff',
  animation: `${spin} 800ms linear infinite`,
  pointerEvents: 'none',
});

export const controlBar = style({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  padding: '26px 8px 5px',
  background:
    'linear-gradient(to top, rgba(0, 0, 0, 0.78) 0%, rgba(0, 0, 0, 0.42) 55%, rgba(0, 0, 0, 0) 100%)',
  color: '#fff',
  cursor: 'default',
  opacity: 0,
  transform: 'translateY(6px)',
  transition: 'opacity 170ms ease, transform 170ms ease',
  pointerEvents: 'none',
  selectors: {
    '&[data-visible="true"]': { opacity: 1, transform: 'none', pointerEvents: 'auto' },
  },
});

export const controlRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  minWidth: 0,
});

export const controlSpacer = style({ flex: 1, minWidth: 0 });

export const controlBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  padding: 0,
  flexShrink: 0,
  borderRadius: 8,
  border: 'none',
  background: 'transparent',
  color: '#fff',
  cursor: 'pointer',
  transition: 'background 120ms ease',
  selectors: {
    '&:hover': { background: 'rgba(255, 255, 255, 0.18)' },
    '&:focus-visible': { outline: '2px solid rgba(255, 255, 255, 0.8)', outlineOffset: -2 },
  },
});

export const controlTime = style({
  marginLeft: 4,
  color: 'rgba(255, 255, 255, 0.92)',
  fontSize: '11.5px',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
});

export const controlTimeTotal = style({ color: 'rgba(255, 255, 255, 0.6)' });

// ── Video ilerleme çubuğu ─────────────────────────────────────────────────────

export const scrub = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  height: 14,
  margin: '0 6px',
  cursor: 'pointer',
  touchAction: 'none',
  selectors: {
    '&[data-disabled="true"]': { cursor: 'default', opacity: 0.5 },
  },
});

export const scrubTrack = style({
  position: 'relative',
  width: '100%',
  height: 3,
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.26)',
  overflow: 'hidden',
  transition: 'height 120ms ease',
  selectors: {
    [`${scrub}:hover &, ${scrub}[data-active="true"] &`]: { height: 5 },
  },
});

export const scrubBuffered = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  background: 'rgba(255, 255, 255, 0.3)',
});

export const scrubPlayed = style({
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: 999,
  background: '#fff',
});

export const scrubThumb = style({
  position: 'absolute',
  top: '50%',
  width: 12,
  height: 12,
  marginTop: -6,
  marginLeft: -6,
  borderRadius: 999,
  background: '#fff',
  boxShadow: '0 1px 5px rgba(0, 0, 0, 0.55)',
  transform: 'scale(0)',
  transition: 'transform 120ms ease',
  pointerEvents: 'none',
  selectors: {
    [`${scrub}:hover &, ${scrub}[data-active="true"] &`]: { transform: 'scale(1)' },
    [`${scrub}[data-disabled="true"] &`]: { display: 'none' },
  },
});

// ── Kart altı (ad, ayrıntı, eylemler) ─────────────────────────────────────────

export const footer = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  padding: '0 8px 0 13px',
  boxSizing: 'border-box',
  color: vars.fgBody,
  selectors: {
    '&[data-compact="true"]': { padding: '0 10px 0 11px' },
  },
});

export const footerText = style({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 1,
  flex: 1,
  minWidth: 0,
  selectors: {
    [`${footer}[data-compact="true"] &`]: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'flex-start',
      gap: 7,
    },
  },
});

export const footerName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '12.5px',
  fontWeight: 550,
  lineHeight: '16px',
  color: vars.fg,
});

export const footerDetail = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '11px',
  lineHeight: '14px',
  color: vars.fgMuted,
  fontVariantNumeric: 'tabular-nums',
  selectors: {
    [`${footer}[data-compact="true"] &`]: { flexShrink: 0 },
  },
});

export const actions = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 1,
  flexShrink: 0,
});

export const iconAction = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  flexShrink: 0,
  borderRadius: 8,
  border: 'none',
  background: 'transparent',
  color: vars.fgMuted,
  textDecoration: 'none',
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
  selectors: {
    '&:hover': { color: vars.fg, background: hoverTint },
    '&:focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: -2 },
    '&:disabled': { opacity: 0.45, cursor: 'default' },
  },
});

/** Karoların sağ üstünde, üzerine gelince beliren camsı eylem kümesi. */
export const floatingActions = style({
  position: 'absolute',
  top: 7,
  right: 7,
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
    [`${videoCard}:hover &, ${videoCard}:focus-within &`]: { opacity: 1, pointerEvents: 'auto' },
  },
});

export const glassIconAction = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  padding: 0,
  borderRadius: 8,
  border: 'none',
  background: 'transparent',
  color: '#f4f4f5',
  textDecoration: 'none',
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: 'rgba(255, 255, 255, 0.18)' },
    '&:focus-visible': { outline: '2px solid rgba(255, 255, 255, 0.7)', outlineOffset: -2 },
    '&:disabled': { opacity: 0.5, cursor: 'default' },
  },
});

// ── Ses kartı ─────────────────────────────────────────────────────────────────

export const audioCard = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  width: '100%',
  maxWidth: 460,
  padding: '0 8px 0 11px',
  borderRadius: 14,
  background: vars.bg1,
  color: vars.fgBody,
  boxSizing: 'border-box',
  overflow: 'hidden',
  selectors: {
    '&::after': {
      content: '',
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      boxShadow: ring,
      pointerEvents: 'none',
    },
  },
});

export const audioPlay = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 38,
  height: 38,
  padding: 0,
  flexShrink: 0,
  borderRadius: 999,
  border: 'none',
  background: vars.fg,
  color: vars.bg,
  cursor: 'pointer',
  transition: 'transform 140ms ease, opacity 140ms ease',
  selectors: {
    '&:hover': { transform: 'scale(1.06)' },
    '&:active': { transform: 'scale(0.95)' },
    '&:focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: 2 },
    '&:disabled': { opacity: 0.4, cursor: 'default', transform: 'none' },
  },
});

export const audioBody = style({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 3,
  flex: 1,
  minWidth: 0,
});

export const audioTitleRow = style({
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  minWidth: 0,
});

export const audioName = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '12.5px',
  fontWeight: 550,
  lineHeight: '16px',
  color: vars.fg,
});

export const audioDetail = style({
  flexShrink: 0,
  maxWidth: '60%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '11px',
  lineHeight: '14px',
  color: vars.fgMuted,
  fontVariantNumeric: 'tabular-nums',
});

export const audioWaveRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  minWidth: 0,
});

export const wave = style({
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flex: 1,
  minWidth: 0,
  height: 22,
  cursor: 'pointer',
  touchAction: 'none',
  selectors: {
    '&[data-disabled="true"]': { cursor: 'default' },
    '&:focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: 2, borderRadius: 4 },
  },
});

export const waveBar = style({
  flex: 1,
  minWidth: 1,
  borderRadius: 999,
  background: `color-mix(in srgb, ${vars.fg} 22%, transparent)`,
  transition: 'background 120ms ease',
  selectors: {
    '&[data-on="true"]': { background: vars.fg },
  },
});

export const audioTime = style({
  flexShrink: 0,
  minWidth: 34,
  textAlign: 'right',
  fontSize: '11px',
  lineHeight: '14px',
  color: vars.fgMuted,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
});
