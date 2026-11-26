import { PLAN_ICON_PROPS } from './shared';

/** Completed: stroke circle with a check mark in the middle. */
export function PlanCompletedIcon() {
  return (
    <svg {...PLAN_ICON_PROPS} stroke-width="1.4">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M4.6 7.2 6.2 8.8 9.5 5.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
