import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type PlanStyleVars = {
  cardH: number;
  padX: number;
  padY: number;
  iconBox: number;
  entryMinH: number;
  iconGap: number;
  entryGap: number;
};

export const planVars = createVariableThemeContract<PlanStyleVars>({
  cardH: null,
  padX: null,
  padY: null,
  iconBox: null,
  entryMinH: null,
  iconGap: null,
  entryGap: null,
});

// ── Claude / Antigravity tarzı sade canlı adım listesi kartı ──────────────────

export const planCard = style({
  border: `1px solid color-mix(in srgb, ${vars.border} 72%, transparent)`,
  borderRadius: vars.radiusXl,
  backgroundColor: `color-mix(in srgb, ${vars.bg1} 65%, ${vars.bg})`,
  boxSizing: 'border-box',
  overflow: 'hidden',
  height: planVars.cardH,
  paddingLeft: planVars.padX,
  paddingRight: planVars.padX,
});

export const planEntryActive = style({
  color: vars.fg,
});

export const planEntryPending = style({
  color: vars.fgPassive,
});

export const planEntryCompleted = style({
  color: vars.fgPassive,
  opacity: 0.78,
});
