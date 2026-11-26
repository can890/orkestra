import type { CreatePlanToolCall, PlanEntry, PlanState } from '@orkestra/core/runtimes/acp/api';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AcpChatStore } from './acp-chat-store';

function StepSpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.22" />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="13 25"
        className="origin-center animate-spin"
        style={{ animationDuration: '0.95s' }}
      />
    </svg>
  );
}

function StepCompletedIcon({ className }: { className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path
        d="M5.4 8.2 7.2 10 10.7 6.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StepPendingIcon({ className }: { className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeDasharray="2.5 2.5"
      />
    </svg>
  );
}

function subscribePlan(store: AcpChatStore, listener: () => void): () => void {
  const session = store.session;
  if (!session) return () => {};
  const unsubPlan = session.plan.onChange(listener);
  const unsubTurn = session.activeTurn.onChange(listener);
  return () => {
    unsubPlan();
    unsubTurn();
  };
}

const EMPTY_ENTRIES: readonly PlanEntry[] = [];

function activeTurnPlanEntries(store: AcpChatStore): readonly PlanEntry[] {
  const session = store.session;
  const activeTurn = session?.activeTurn.current() ?? null;
  if (activeTurn) {
    for (let i = activeTurn.items.length - 1; i >= 0; i -= 1) {
      const item = activeTurn.items[i];
      if (item?.kind === 'create-plan-tool-call') {
        const planItem = item as CreatePlanToolCall;
        if (planItem.entries && planItem.entries.length > 0) return planItem.entries;
        const sessionPlan = session?.plan.current() as PlanState | null | undefined;
        if (sessionPlan?.entries?.length) return sessionPlan.entries;
      }
    }
    return EMPTY_ENTRIES;
  }
  return EMPTY_ENTRIES;
}

/**
 * Ajan çalışırken sohbetin en altında (mesaj kutusunun hemen üstünde) sabit duran,
 * ilerleme çubuklu ve daraltılabilir canlı çalışma adımları kartı.
 */
export const LivePlanDock = observer(function LivePlanDock({ store }: { store: AcpChatStore }) {
  const [collapsed, setCollapsed] = useState(false);

  // Sohbet değiştiğinde kartı tekrar açık başlat.
  useEffect(() => {
    setCollapsed(false);
  }, [store.conversationId]);

  const session = store.session;
  const isWorking = store.affordances.isWorking;

  const entries = useSyncExternalStore(
    (listener) => subscribePlan(store, listener),
    () => activeTurnPlanEntries(store)
  );

  if (!session || !isWorking || entries.length === 0) return null;

  const total = entries.length;
  const completedCount = entries.filter((entry) => entry.status === 'completed').length;
  const activeEntry = entries.find((entry) => entry.status === 'in_progress') ?? null;
  const allDone = completedCount === total;
  const progressPct = Math.min(
    100,
    Math.round(((completedCount + (activeEntry ? 0.35 : 0)) / total) * 100)
  );

  const headerTitle = collapsed
    ? (activeEntry?.content ?? (allDone ? 'Tüm adımlar tamamlandı' : 'Çalışma adımları'))
    : 'Çalışma adımları';

  return (
    <div
      className="mx-3 mb-2 overflow-hidden rounded-2xl border border-border/70 bg-surface-1/90 shadow-sm backdrop-blur-md transition-all dark:border-white/[0.085] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.045)_0%,rgba(255,255,255,0.015)_100%)] dark:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.06)]"
      role="region"
      aria-label="Canlı çalışma adımları"
    >
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center justify-between gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-foreground/[0.03] dark:hover:bg-white/[0.03]"
      >
        <div className="flex min-w-0 items-center gap-2">
          {allDone ? (
            <StepCompletedIcon className="shrink-0 text-emerald-500 dark:text-emerald-400" />
          ) : (
            <StepSpinnerIcon className="shrink-0 text-foreground/90" />
          )}
          <span
            className={
              collapsed
                ? 'truncate text-[12.5px] font-medium text-foreground'
                : 'truncate text-[11.5px] font-medium tracking-[0.01em] text-foreground-muted'
            }
          >
            {headerTitle}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground-muted dark:bg-white/[0.07]">
            {completedCount}/{total}
          </span>
          {collapsed ? (
            <ChevronUp className="size-3.5 text-foreground-muted/80" />
          ) : (
            <ChevronDown className="size-3.5 text-foreground-muted/80" />
          )}
        </div>
      </button>

      {/* İncecik canlı ilerleme çizgisi */}
      <div className="h-[2px] w-full bg-foreground/[0.05] dark:bg-white/[0.05]">
        <div
          className="h-full bg-gradient-to-r from-emerald-400/90 via-teal-400/85 to-sky-400/90 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(progressPct, 4)}%` }}
        />
      </div>

      {!collapsed && (
        <ul className="max-h-52 space-y-0.5 overflow-y-auto px-2 py-2">
          {entries.map((entry, idx) => {
            const isActive = entry.status === 'in_progress';
            const isCompleted = entry.status === 'completed';
            return (
              <li
                key={entry.id || `${idx}:${entry.content}`}
                className={
                  isActive
                    ? 'flex items-start gap-2.5 rounded-xl bg-foreground/[0.05] px-2.5 py-1.5 ring-1 ring-foreground/[0.06] transition-colors dark:bg-white/[0.055] dark:ring-white/[0.07]'
                    : 'flex items-start gap-2.5 rounded-xl px-2.5 py-1 transition-colors'
                }
              >
                <span className="mt-[2px] flex shrink-0 items-center justify-center">
                  {isCompleted ? (
                    <StepCompletedIcon className="text-emerald-500/80 dark:text-emerald-400/80" />
                  ) : isActive ? (
                    <StepSpinnerIcon className="text-foreground" />
                  ) : (
                    <StepPendingIcon className="text-foreground/30" />
                  )}
                </span>
                <span
                  className={
                    isActive
                      ? 'min-w-0 flex-1 text-[13px] leading-[1.45] font-medium text-foreground'
                      : isCompleted
                        ? 'min-w-0 flex-1 text-[12.5px] leading-[1.45] text-foreground/45 line-through decoration-foreground/20'
                        : 'min-w-0 flex-1 text-[12.5px] leading-[1.45] text-foreground/60'
                  }
                >
                  {entry.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
