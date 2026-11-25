import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { messageGroup } from '@components/primitives/copy-button.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type AssistantStyleVars = { height: number };

export const assistantVars = createVariableThemeContract<AssistantStyleVars>({ height: null });

export const assistantRoot = style({ height: assistantVars.height });

export const messageText = recipe({
  variants: {
    role: {
      assistant: { color: vars.fgBody },
      thought: { color: vars.fgMuted, fontStyle: 'italic' },
    },
  },
});

export const assistantOuter = style([messageGroup, { position: 'relative' }]);

export const srOnly = style({
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
});

export const footerRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
});

export const assistantActionReveal = style({
  opacity: 0,
  transition: 'opacity 140ms ease',
  selectors: {
    [`${messageGroup}:hover &`]: { opacity: 1 },
    [`${messageGroup}:focus-within &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
  },
});

export const assistantActionBtn = style([
  assistantActionReveal,
  {
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    border: 'none',
    background: 'transparent',
    borderRadius: vars.radiusSm,
    color: vars.fgPassive,
    transition: 'opacity 140ms ease, color 150ms ease, background-color 150ms ease',
    selectors: {
      '&:hover': { color: vars.fg, backgroundColor: vars.bg2 },
      '&:focus-visible': {
        outline: '2px solid currentColor',
        outlineOffset: '1px',
        color: vars.fg,
      },
    },
  },
]);

export const assistantTimestamp = style({
  fontSize: '11px',
  lineHeight: '16px',
  color: vars.fgPassive,
  fontVariantNumeric: 'tabular-nums',
  paddingLeft: '4px',
  userSelect: 'none',
  opacity: 0.72,
  transition: 'opacity 140ms ease, color 140ms ease',
  selectors: {
    [`${messageGroup}:hover &`]: { opacity: 1, color: vars.fgMuted },
  },
});
