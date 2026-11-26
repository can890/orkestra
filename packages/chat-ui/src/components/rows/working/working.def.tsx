import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import { formatTurnFoldDuration } from '@state/turn-fold';
import { createSignal, onCleanup } from 'solid-js';
import type { WorkingItem } from '@/model';
import { thinkingDot, thinkingDots } from '@components/primitives/collapse-header.css';
import { textShimmer } from '@styles/effects.css';
import { vars } from '@styles/theme.css';

export const workingUnitDef = defineUnit<WorkingItem, { rowH: number }>({
  kind: 'working',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const mountTime = Date.now();
    const resolveStart = () =>
      typeof props.data.startedAt === 'number' && props.data.startedAt >= 1_000_000_000_000
        ? props.data.startedAt
        : mountTime;
    const [elapsedMs, setElapsedMs] = createSignal(Math.max(0, Date.now() - resolveStart()));
    const timer = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - resolveStart()));
    }, 1000);
    onCleanup(() => clearInterval(timer));

    const label = () => {
      const dur = formatTurnFoldDuration(elapsedMs());
      return dur ? `${dur} · Çalışıyor` : 'Düşünüyor';
    };

    return (
      <div
        style={{
          height: `${props.vars.rowH}px`,
          display: 'flex',
          'align-items': 'center',
          gap: '4px',
          color: vars.fgMuted,
          'font-size': '13px',
          'user-select': 'none',
        }}
      >
        <span class={thinkingDots} aria-hidden="true">
          <span class={thinkingDot} />
          <span class={thinkingDot} />
          <span class={thinkingDot} />
        </span>
        <span class={textShimmer}>{label()}</span>
      </div>
    );
  },
});
