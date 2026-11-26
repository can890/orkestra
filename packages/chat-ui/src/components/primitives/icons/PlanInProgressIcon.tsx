import { PLAN_ICON_PROPS } from './shared';
import { planSpinner } from '@styles/effects.css';

/**
 * In-progress: subtle base ring with a crisp rotating arc segment,
 * matching Claude / Antigravity live checklist spinners.
 */
export function PlanInProgressIcon() {
  // Circumference for r=5.5 is ~34.56; ~35% arc (12) + 65% gap (22.6).
  return (
    <svg {...PLAN_ICON_PROPS} stroke-width="1.5">
      <circle cx="7" cy="7" r="5.5" opacity="0.22" />
      <circle
        class={planSpinner}
        cx="7"
        cy="7"
        r="5.5"
        stroke-linecap="round"
        stroke-dasharray="12 22.6"
      />
    </svg>
  );
}
