import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// ── ZoomViewerDialog ──────────────────────────────────────────────────────────

export const toolbarRow = style({
  display: 'flex',
  flexShrink: 0,
  justifyContent: 'flex-end',
  padding: '0.75rem',
  paddingBottom: '0.5rem',
});

export const toolbarGroup = style({
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surface,
  boxShadow: vars.shadowSm,
});

// Buttons sit flush inside the bordered group; the group's overflow clipping
// owns the outer corner rounding. Radius removal must go through the
// utilities layer to win over the control recipe.
export const toolbarButton = style({
  '@layer': {
    utilities: { borderRadius: 0 },
  },
});

export const viewerBody = style({
  minHeight: 0,
  flex: 1,
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingBottom: '0.5rem',
});

// Sizing is owned by the inline wrapperStyle passed to TransformComponent
// (react-zoom-pan-pinch defaults the wrapper to fit-content otherwise).
export const transformWrapper = style({
  borderRadius: tokenVars.radiusMd,
  backgroundColor: vars.background1,
});

export const unavailable = style({
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
});

export const unavailableContainer = style({
  display: 'flex',
  minHeight: 0,
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
  paddingTop: 0,
});

// ── ContainedImage / ExpandableImage ─────────────────────────────────────────

export const containedImage = style({
  objectFit: 'contain',
});

// Inside the zoom dialog the image renders at natural size; the transform
// wrapper owns scaling, so viewport-relative caps must come off.
export const zoomTargetImage = style({
  display: 'block',
  height: 'auto',
  maxHeight: 'none',
  maxWidth: 'none',
});

export const expandableContainer = style({
  position: 'relative',
  display: 'inline-block',
  maxWidth: '100%',
  verticalAlign: 'top',
});

export const expandButton = style({
  position: 'absolute',
  top: '0.25rem',
  right: '0.25rem',
  zIndex: 10,
  opacity: 0,
  transition: 'opacity 150ms',
  backgroundColor: vars.surface,
  boxShadow: `${vars.shadowSm}, 0 0 0 1px color-mix(in srgb, ${vars.border} 80%, transparent)`,
  selectors: {
    [`${expandableContainer}:hover &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
  },
});

// ── Compact Claude-style Lightbox ─────────────────────────────────────────────

export const lightboxBackdrop = style({
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  backgroundColor: 'rgba(0, 0, 0, 0.72)',
  backdropFilter: 'blur(4px)',
});

export const lightboxPositioner = style({
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1.5rem',
});

export const lightboxCard = style({
  position: 'relative',
  width: 'fit-content',
  height: 'fit-content',
  maxWidth: 'min(82vw, 880px)',
  maxHeight: 'min(78vh, 660px)',
  borderRadius: '14px',
  overflow: 'hidden',
  backgroundColor: '#141416',
  border: '1px solid rgba(255, 255, 255, 0.12)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.65)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  outline: 'none',
});

export const lightboxMedia = style({
  display: 'block',
  maxWidth: 'min(82vw, 880px)',
  maxHeight: 'min(78vh, 660px)',
  width: 'auto',
  height: 'auto',
  objectFit: 'contain',
  userSelect: 'none',
});

export const lightboxUnavailable = style({
  padding: '2rem 2.5rem',
  fontSize: tokenVars.textSm,
  color: 'rgba(255, 255, 255, 0.72)',
});

export const lightboxControls = style({
  position: 'absolute',
  top: '0.625rem',
  right: '0.625rem',
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
});

export const lightboxIconBtn = style({
  width: '1.75rem',
  height: '1.75rem',
  borderRadius: '9999px',
  border: '1px solid rgba(255, 255, 255, 0.16)',
  backgroundColor: 'rgba(18, 18, 22, 0.68)',
  backdropFilter: 'blur(8px)',
  color: 'rgba(255, 255, 255, 0.9)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  textDecoration: 'none',
  transition: 'background-color 140ms ease, color 140ms ease',
  selectors: {
    '&:hover': {
      backgroundColor: 'rgba(18, 18, 22, 0.92)',
      color: '#ffffff',
    },
    '&:focus-visible': {
      outline: '2px solid rgba(255, 255, 255, 0.6)',
      outlineOffset: '1px',
    },
  },
});

export const lightboxNavBtn = style([
  lightboxIconBtn,
  {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '2rem',
    height: '2rem',
    zIndex: 3,
  },
]);

export const lightboxNavPrev = style({
  left: '0.625rem',
});

export const lightboxNavNext = style({
  right: '0.625rem',
});

export const lightboxCounter = style({
  position: 'absolute',
  bottom: '0.625rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 3,
  padding: '0.125rem 0.625rem',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  lineHeight: '1.25rem',
  color: 'rgba(255, 255, 255, 0.92)',
  backgroundColor: 'rgba(18, 18, 22, 0.68)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});
