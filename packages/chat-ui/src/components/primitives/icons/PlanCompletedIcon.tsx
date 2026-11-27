import { PLAN_ICON_PROPS } from './shared';

/** Completed: Claude tarzı yumuşak dolgulu çember + temiz tik. */
export function PlanCompletedIcon() {
  return (
    <svg {...PLAN_ICON_PROPS} stroke-width="1.35">
      <circle cx="7" cy="7" r="5.5" fill="currentColor" fill-opacity="0.14" stroke-opacity="0.5" />
      <path d="M4.6 7.2 6.2 8.8 9.5 5.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
