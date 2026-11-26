import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
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
    const startedAt = Date.now();
    const [elapsed, setElapsed] = createSignal(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    onCleanup(() => clearInterval(timer));

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
        <span class={textShimmer}>
          {elapsed() < 1 ? 'Düşünüyor' : `${elapsed()}sn · Düşünüyor`}
        </span>
      </div>
    );
  },
});
