import { useTheme } from '@components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@components/engine/row-metrics';
import { formatClockTime } from '@components/rows/message/format-time';
import type { MeasureCtx } from '@core/define';
import { defineUnit } from '@core/units';
import { formatTurnFoldLabel, formatTurnFoldMeta } from '@state/turn-fold';
import { Show } from 'solid-js';
import type { TurnFoldItem } from '@/model';
import {
  turnFoldChevron,
  turnFoldChevronExpanded,
  turnFoldLabelWrap,
  turnFoldMeta,
  turnFoldRow,
  turnFoldRule,
} from './turn-fold.css';

function turnFoldHeight(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function TurnFoldRender(props: { data: TurnFoldItem }) {
  const theme = useTheme();
  const height = () => theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
  const label = () => formatTurnFoldLabel(props.data);
  const meta = () => formatTurnFoldMeta(props.data);
  const clockTime = () => formatClockTime(props.data.completedAt);

  return (
    <div
      class={turnFoldRow}
      style={{ height: `${height()}px` }}
      role="button"
      tabIndex={0}
      aria-expanded={props.data.expanded ? 'true' : 'false'}
      data-collapse-id={props.data.id}
      data-turn-fold-id={props.data.id}
      title={
        props.data.expanded
          ? 'Ara adımları ve önceki yazıları gizle'
          : 'Ara adımları ve önceki yazıları göster'
      }
    >
      <span class={turnFoldLabelWrap}>
        <span>{label()}</span>
        <Show when={clockTime()}>{(t) => <span class={turnFoldMeta}>· {t()}</span>}</Show>
        <Show when={meta()}>{(m) => <span class={turnFoldMeta}>({m()})</span>}</Show>
        <span
          class={turnFoldChevron}
          classList={{ [turnFoldChevronExpanded]: props.data.expanded }}
          aria-hidden="true"
        >
          ›
        </span>
      </span>
      <span class={turnFoldRule} aria-hidden="true" />
    </div>
  );
}

export const turnFoldUnitDef = defineUnit<TurnFoldItem>({
  kind: 'turn-fold',
  margin: { top: 6, bottom: 6 },
  estimate: (_data, ctx) => turnFoldHeight(ctx),
  measure: (_data, ctx) => turnFoldHeight(ctx),
  Render: TurnFoldRender,
});
