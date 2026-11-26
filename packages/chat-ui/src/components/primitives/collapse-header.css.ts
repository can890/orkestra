import { keyframes, style } from '@vanilla-extract/css';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';

const thinkingDotPulse = keyframes({
  '0%, 80%, 100%': { opacity: 0.35, transform: 'translateY(0)' },
  '40%': { opacity: 1, transform: 'translateY(-1.5px)' },
});

/** Claude tarzı sıcak mercan üç nokta animasyonu (•••). */
export const thinkingDots = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  marginRight: '4px',
  flexShrink: 0,
  color: '#e07a5f',
});

export const thinkingDot = style({
  width: '4px',
  height: '4px',
  borderRadius: '9999px',
  backgroundColor: 'currentColor',
  animation: `${thinkingDotPulse} 1.2s ease-in-out infinite`,
  selectors: {
    '&:nth-child(2)': { animationDelay: '0.18s' },
    '&:nth-child(3)': { animationDelay: '0.36s' },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
      opacity: 0.85,
    },
  },
});

export const collapseRow = sx({
  display: 'flex',
  alignItems: 'center',
  gap: '1.5',
  cursor: 'pointer',
  color: 'fgPassive',
  userSelect: 'none',
});

export const collapseRowHover = style({
  selectors: {
    '&:hover': { color: vars.fgMuted },
  },
});

/** Combined class for the header row element. */
export const collapseHeader = style([
  collapseRow,
  collapseRowHover,
  { fontSize: vars.typeBodyFontSize },
]);

export const chevron = style({
  display: 'inline-block',
  fontSize: '10px',
  transition: 'transform 150ms ease-out',
});

export const chevronExpanded = style({
  transform: 'rotate(90deg)',
});

export const collapseStatusError = style({
  marginLeft: 'auto',
  display: 'flex',
  color: vars.fgError,
});

export const collapseStatusPermission = style({
  marginLeft: 'auto',
  display: 'flex',
  color: '#eab308',
});
