import { useCommands } from '@components/contexts/CommandsContext';
import { clsx } from 'clsx';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { ChatSubagentToolCall, SubagentPhase } from '@/model';
import {
  subagentChevron,
  subagentChevronExpanded,
  subagentDotCompleted,
  subagentDotFailed,
  subagentHeader,
  subagentIndicator,
  subagentName,
  subagentNameRow,
  subagentOpenButton,
  subagentStatusRow,
  subagentStatusRowCollapsible,
} from './subagent.css';
import { textShimmer } from '@styles/effects.css';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

const PHASE_LABELS: Record<SubagentPhase, string> = {
  spawning: 'Başlatılıyor',
  running: 'Çalışıyor',
  completed: 'Tamamlandı',
  failed: 'Başarısız',
};

function SubagentProgressIndicator(props: { phase: SubagentPhase }) {
  const [frame, setFrame] = createSignal(0);

  // The phase can change live (Orkestra workers); the spinner only runs while active.
  createEffect(() => {
    if (props.phase !== 'spawning' && props.phase !== 'running') return;
    const interval = window.setInterval(() => {
      setFrame((value) => (value + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <span class={subagentIndicator} aria-label={PHASE_LABELS[props.phase]}>
      <Show
        when={props.phase === 'completed' || props.phase === 'failed'}
        fallback={SPINNER_FRAMES[frame()]}
      >
        <span
          class={props.phase === 'completed' ? subagentDotCompleted : subagentDotFailed}
          title={PHASE_LABELS[props.phase]}
        />
      </Show>
    </span>
  );
}

export function SubagentHeader(props: {
  item: ChatSubagentToolCall;
  height: number;
  expanded?: boolean;
  collapsible?: boolean;
}) {
  const commands = useCommands();
  const source = () => props.item.source ?? 'subagent';
  const phase = (): SubagentPhase => {
    const toolCallId = props.item.toolCallId;
    const live = toolCallId
      ? commands().resolveSubagentPhase?.({ toolCallId, name: props.item.name, source: source() })
      : undefined;
    return live ?? props.item.phase;
  };
  const kindLabel = () => (source() === 'orchestra-worker' ? 'Orkestra işçisi' : 'Alt ajan');
  const label = () => `${kindLabel()} · ${PHASE_LABELS[phase()]}`;
  const name = () => (props.item.background ? `${props.item.name} (arka plan)` : props.item.name);
  const canOpen = () => Boolean(props.item.toolCallId && commands().onOpenSubagent);

  return (
    <div class={subagentHeader} style={{ height: `${props.height}px` }}>
      <div class={subagentNameRow}>
        <SubagentProgressIndicator phase={phase()} />
        <span class={clsx(subagentName, phase() === 'running' && textShimmer)} title={name()}>
          {name()}
        </span>
        <Show when={canOpen()}>
          <span
            class={subagentOpenButton}
            role="button"
            title="Alt ajanı yan panelde izle"
            data-subagent-open={props.item.id}
            data-subagent-tool-call-id={props.item.toolCallId}
            data-subagent-name={props.item.name}
            data-subagent-source={source()}
          >
            İzle ›
          </span>
        </Show>
      </div>
      <div
        class={clsx(subagentStatusRow, props.collapsible && subagentStatusRowCollapsible)}
        data-collapse-id={props.collapsible ? props.item.id : undefined}
        role={props.collapsible ? 'button' : undefined}
        aria-expanded={props.collapsible ? Boolean(props.expanded) : undefined}
        title={phase() === 'failed' ? (props.item.error ?? PHASE_LABELS.failed) : undefined}
      >
        <span>{label()}</span>
        <Show when={props.collapsible}>
          <span class={clsx(subagentChevron, props.expanded && subagentChevronExpanded)}>›</span>
        </Show>
      </div>
    </div>
  );
}
