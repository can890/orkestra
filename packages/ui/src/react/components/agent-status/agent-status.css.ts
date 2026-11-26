import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

const ringSpin = keyframes({
  '0%': { transform: 'rotate(0deg)' },
  '100%': { transform: 'rotate(360deg)' },
});

export const root = style({
  '@layer': {
    recipes: {
      display: 'inline-flex',
      width: 'var(--agent-status-size, 1.125rem)',
      height: 'var(--agent-status-size, 1.125rem)',
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
    },
  },
});

export const icon = style({
  '@layer': {
    recipes: {
      display: 'block',
      width: '100%',
      height: '100%',
      overflow: 'visible',
    },
  },
});

export const workingIcon = style({
  '@layer': {
    recipes: {
      color: vars.foregroundMuted,
      animation: `${ringSpin} 0.95s linear infinite`,
      '@media': {
        '(prefers-reduced-motion: reduce)': {
          animation: 'none',
        },
      },
    },
  },
});

export const workingTrack = style({
  '@layer': {
    recipes: {
      fill: 'none',
      stroke: 'currentColor',
      opacity: 0.2,
    },
  },
});

export const workingArc = style({
  '@layer': {
    recipes: {
      fill: 'none',
      stroke: 'currentColor',
      opacity: 0.92,
      strokeLinecap: 'round',
    },
  },
});

export const warningShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundWarning,
      stroke: vars.foregroundWarning,
    },
  },
});

export const successShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundSuccess,
      stroke: vars.foregroundSuccess,
    },
  },
});

export const errorShape = style({
  '@layer': {
    recipes: {
      fill: vars.backgroundError,
      stroke: vars.foregroundError,
    },
  },
});

export const errorMark = style({
  '@layer': {
    recipes: {
      fill: vars.foregroundError,
      stroke: vars.foregroundError,
      strokeLinecap: 'round',
    },
  },
});
