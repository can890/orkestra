import { BlockStackView } from '@components/primitives/BlockStackView';
import {
  PlanCompletedIcon,
  PlanInProgressIcon,
  PlanPendingIcon,
} from '@components/primitives/icons';
import { vars } from '@styles/theme.css';
import { For, Match, Switch } from 'solid-js';
import type { PlanEntryStatus } from '@/model';
import type { PlanEntryLaid } from './plan.def';
import {
  planEntryActive,
  planEntryCompleted,
  planEntryPending,
  planVars,
} from './plan.css';

// ── Status visual helpers ─────────────────────────────────────────────────────

function iconColor(status: PlanEntryStatus): string {
  if (status === 'completed') return vars.planDone;
  if (status === 'in_progress') return vars.fg;
  return vars.fgPassive;
}

function entryTextClass(status: PlanEntryStatus): string {
  if (status === 'in_progress') return planEntryActive;
  if (status === 'completed') return planEntryCompleted;
  return planEntryPending;
}

function statusAriaLabel(status: PlanEntryStatus): string {
  if (status === 'completed') return 'tamamlandı';
  if (status === 'in_progress') return 'devam ediyor';
  return 'bekliyor';
}

// ── PlanList ──────────────────────────────────────────────────────────────────

export type PlanListProps = {
  entries: PlanEntryLaid[];
};

export function PlanList(props: PlanListProps) {
  return (
    <div
      style={{
        'padding-top': planVars.padY,
        'padding-bottom': planVars.padY,
      }}
    >
      <For each={props.entries}>
        {(entry, i) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'flex-start',
              'column-gap': planVars.iconGap,
              'margin-top': i() > 0 ? planVars.entryGap : '0',
            }}
          >
            <div
              style={{
                width: planVars.iconBox,
                height: planVars.entryMinH,
                'flex-shrink': '0',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                color: iconColor(entry.status),
                'user-select': 'none',
              }}
              aria-label={statusAriaLabel(entry.status)}
            >
              <Switch>
                <Match when={entry.status === 'completed'}>
                  <PlanCompletedIcon />
                </Match>
                <Match when={entry.status === 'in_progress'}>
                  <PlanInProgressIcon />
                </Match>
                <Match when={entry.status === 'pending'}>
                  <PlanPendingIcon />
                </Match>
              </Switch>
            </div>
            <div class={entryTextClass(entry.status)} style={{ flex: '1', 'min-width': '0' }}>
              <BlockStackView node={entry.measured} />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
