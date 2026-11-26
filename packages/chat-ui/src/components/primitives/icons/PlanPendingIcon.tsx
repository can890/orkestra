import { PLAN_ICON_PROPS } from './shared';

/** Pending: crisp dashed circle matching Claude / Antigravity step checklists. */
export function PlanPendingIcon() {
  return (
    <svg {...PLAN_ICON_PROPS} stroke-width="1.35">
      <circle cx="7" cy="7" r="5.5" stroke-linecap="round" stroke-dasharray="2.4 2.4" />
    </svg>
  );
}
