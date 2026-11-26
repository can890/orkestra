import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const turnFoldRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  cursor: 'pointer',
  userSelect: 'none',
  color: vars.fgMuted,
  fontSize: '12px',
  lineHeight: '18px',
  transition: 'color 120ms ease',
  selectors: {
    '&:hover': {
      color: vars.fg,
    },
  },
});

export const turnFoldRule = style({
  flex: 1,
  height: '1px',
  backgroundColor: vars.border,
  opacity: 0.7,
});

export const turnFoldLabelWrap = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
});

export const turnFoldMeta = style({
  color: vars.fgPassive,
  fontSize: '11px',
});

export const turnFoldChevron = style({
  display: 'inline-block',
  fontSize: '13px',
  lineHeight: 1,
  transition: 'transform 140ms ease',
});

export const turnFoldChevronExpanded = style({
  transform: 'rotate(90deg)',
});
