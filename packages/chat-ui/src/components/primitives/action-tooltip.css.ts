import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

const actionTooltipBase = style({
  position: 'relative',
  selectors: {
    '&::after': {
      content: 'attr(data-tooltip)',
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      pointerEvents: 'none',
      zIndex: 30,
      whiteSpace: 'nowrap',
      backgroundColor: vars.bg1,
      color: vars.fg,
      border: `1px solid ${vars.border}`,
      borderRadius: vars.radiusMd,
      padding: '4px 10px',
      fontSize: '12px',
      lineHeight: '16px',
      fontWeight: 500,
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
      opacity: 0,
      transition: 'opacity 120ms ease 100ms, transform 120ms ease 100ms',
    },
    '&[data-tooltip=""]::after': {
      display: 'none',
    },
  },
});

export const actionTooltip = style([
  actionTooltipBase,
  {
    selectors: {
      '&::after': {
        left: '50%',
        transform: 'translateX(-50%) translateY(3px)',
      },
      '&:hover::after': {
        opacity: 1,
        transform: 'translateX(-50%) translateY(0)',
      },
      '&:focus-visible::after': {
        opacity: 1,
        transform: 'translateX(-50%) translateY(0)',
      },
    },
  },
]);

export const actionTooltipStart = style([
  actionTooltipBase,
  {
    selectors: {
      '&::after': {
        left: '0',
        transform: 'translateY(3px)',
      },
      '&:hover::after': {
        opacity: 1,
        transform: 'translateY(0)',
      },
      '&:focus-visible::after': {
        opacity: 1,
        transform: 'translateY(0)',
      },
    },
  },
]);

export const actionTooltipEnd = style([
  actionTooltipBase,
  {
    selectors: {
      '&::after': {
        right: '0',
        transform: 'translateY(3px)',
      },
      '&:hover::after': {
        opacity: 1,
        transform: 'translateY(0)',
      },
      '&:focus-visible::after': {
        opacity: 1,
        transform: 'translateY(0)',
      },
    },
  },
]);
