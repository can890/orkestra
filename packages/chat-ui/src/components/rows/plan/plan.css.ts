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

// ── Claude tarzı sade, sıcak antrasit / terracotta akış içi görev kartı ──────

export const planCard = style({
  border: `1px solid color-mix(in srgb, ${vars.border} 58%, transparent)`,
  borderRadius: '16px',
  background: `color-mix(in srgb, ${vars.bg1} 88%, ${vars.bg})`,
  boxShadow: `inset 0 1px 0 color-mix(in srgb, ${vars.fg} 4.5%, transparent)`,
  boxSizing: 'border-box',
  overflow: 'hidden',
  height: planVars.cardH,
  paddingLeft: planVars.padX,
  paddingRight: planVars.padX,
});

export const planEntryActive = style({
  color: vars.fg,
  fontWeight: 500,
});

export const planEntryPending = style({
  color: vars.fgPassive,
  opacity: 0.86,
});

export const planEntryCompleted = style({
  color: vars.fgPassive,
  opacity: 0.68,
});
