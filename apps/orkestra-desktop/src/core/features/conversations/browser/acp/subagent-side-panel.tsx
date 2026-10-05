import type { SubagentPhase, SubagentSource } from '@orkestra/chat-ui';
import { Button } from '@orkestra/ui/react/primitives';
import { Check, ChevronRight, ExternalLink, Loader2, X, XCircle } from 'lucide-react';
import { observer, useObserver } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { OrchestraWorkerSummary } from '@core/features/orchestra/api/orchestra';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import { getAcpChatResourceManager } from './acp-chat-resource-manager';
import type { AcpChatStore } from './acp-chat-store';
import {
  collectNativeSubagents,
  collectOrchestraSpawns,
  findToolNode,
  matchOrchestraWorkers,
  nativeSubagentPhase,
  phaseFromAgentStatus,
  toolFeedEntries,
  transcriptFeed,
  transcriptTurns,
  type OrchestraSpawnRef,
  type SubagentFeedEntry,
} from './subagent-activity';

/** Kullanıcının yan panelde izlediği alt ajan. */
export type SubagentTarget = {
  itemId: string;
  toolCallId: string;
  name: string;
  source: SubagentSource;
};

const POLL_MS = 600;
const SPAWN_POLL_MS = 1_500;
const MAX_FEED_ENTRIES = 300;

const PHASE_LABEL: Record<SubagentPhase, string> = {
  spawning: 'Başlatılıyor',
  running: 'Çalışıyor',
  completed: 'Tamamlandı',
  failed: 'Başarısız',
};

function sameSpawns(left: readonly OrchestraSpawnRef[], right: readonly OrchestraSpawnRef[]) {
  return (
    left.length === right.length &&
    left.every(
      (spawn, index) =>
        spawn.toolCallId === right[index]?.toolCallId &&
        spawn.status === right[index]?.status &&
        spawn.inputSummary === right[index]?.inputSummary
    )
  );
}

export type OrchestraWorkerLinks = {
  workerFor(toolCallId: string): OrchestraWorkerSummary | null;
  phaseFor(toolCallId: string): SubagentPhase | undefined;
  /** Durum veya eşleme değiştiğinde değişir; geri çağrıların yenilenmesi için kullanılır. */
  key: string;
  running: SubagentTarget[];
};

/**
 * Şef sohbetindeki işçi başlatma satırlarını işçi konuşmalarına bağlar ve işçilerin canlı
 * durumunu konuşma deposundaki ajan durumundan okur.
 */
export function useOrchestraWorkerLinks(store: AcpChatStore | null): OrchestraWorkerLinks {
  const [spawns, setSpawns] = useState<OrchestraSpawnRef[]>([]);
  const [workers, setWorkers] = useState<OrchestraWorkerSummary[]>([]);
  const conversationId = store?.conversationId ?? null;

  useEffect(() => {
    setSpawns([]);
    setWorkers([]);
    if (!store) return;
    const tick = () => {
      const next = collectOrchestraSpawns(transcriptTurns(store.chatState.transcript.state));
      setSpawns((previous) => (sameSpawns(previous, next) ? previous : next));
    };
    tick();
    const timer = window.setInterval(tick, SPAWN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [store]);

  const spawnKey = spawns.map((spawn) => `${spawn.toolCallId}:${spawn.status}`).join('|');
  useEffect(() => {
    if (!conversationId || spawns.length === 0) return;
    let cancelled = false;
    void getConversationsClient()
      .then((client) => client.orchestra.get({ conversationId }))
      .then((session) => {
        if (!cancelled) setWorkers(session?.workers ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // spawnKey yeni bir işçi başladığında listeyi tazeler.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [conversationId, spawnKey]);

  const links = useMemo(() => matchOrchestraWorkers(spawns, workers), [spawns, workers]);
  const taskId = store?.taskId ?? null;
  const statuses = useObserver(() => {
    const manager = taskId ? conversationRegistry.get(taskId) : undefined;
    const result: Record<string, SubagentPhase | undefined> = {};
    for (const [toolCallId, worker] of links) {
      result[toolCallId] = phaseFromAgentStatus(
        manager?.conversations.get(worker.workerId)?.status
      );
    }
    return result;
  });
  const statusKey = Object.entries(statuses)
    .map(([toolCallId, phase]) => `${toolCallId}:${phase ?? '-'}`)
    .join('|');

  return useMemo(() => {
    const running: SubagentTarget[] = [];
    for (const spawn of spawns) {
      const worker = links.get(spawn.toolCallId);
      const phase = statuses[spawn.toolCallId];
      if (worker && (phase === 'running' || phase === undefined) && spawn.status !== 'error') {
        running.push({
          itemId: spawn.itemId,
          toolCallId: spawn.toolCallId,
          name: spawn.inputSummary ?? worker.title,
          source: 'orchestra-worker',
        });
      }
    }
    return {
      workerFor: (toolCallId) => links.get(toolCallId) ?? null,
      phaseFor: (toolCallId) => statuses[toolCallId],
      key: `${spawnKey}#${workers.length}#${statusKey}`,
      running,
    };
    // statusKey, statuses nesnesinin içeriğini temsil eder.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [links, spawnKey, statusKey, workers.length]);
}

/** Şef/sohbet dökümünde şu an çalışan yerel alt ajanlar. */
export function useRunningNativeSubagents(store: AcpChatStore | null): SubagentTarget[] {
  const [running, setRunning] = useState<SubagentTarget[]>([]);
  useEffect(() => {
    setRunning([]);
    if (!store) return;
    const tick = () => {
      const next = collectNativeSubagents(transcriptTurns(store.chatState.transcript.state))
        .filter((subagent) => subagent.phase === 'running' || subagent.phase === 'spawning')
        .map((subagent) => ({
          itemId: subagent.itemId,
          toolCallId: subagent.toolCallId,
          name: subagent.name,
          source: 'subagent' as const,
        }));
      setRunning((previous) =>
        previous.length === next.length &&
        previous.every((target, index) => target.toolCallId === next[index]?.toolCallId)
          ? previous
          : next
      );
    };
    tick();
    const timer = window.setInterval(tick, SPAWN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [store]);
  return running;
}

function PhaseIcon({ phase }: { phase: SubagentPhase | undefined }) {
  if (phase === 'completed') return <Check className="size-3.5 text-foreground-success" />;
  if (phase === 'failed') return <XCircle className="size-3.5 text-foreground-destructive" />;
  return <Loader2 className="size-3.5 animate-spin text-foreground-muted" />;
}

function FeedMessage({ entry }: { entry: Extract<SubagentFeedEntry, { kind: 'message' }> }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.text.length > 360;
  return (
    <div
      className={cn(
        'rounded-md px-2 py-1.5 text-xs leading-relaxed',
        entry.role === 'user' ? 'bg-background-2 text-foreground-muted' : 'text-foreground'
      )}
    >
      <div className="mb-0.5 text-[10px] tracking-wide text-foreground-muted uppercase">
        {entry.role === 'user' ? 'Görev' : 'Ajan'}
      </div>
      <div className={cn('break-words whitespace-pre-wrap', !expanded && long && 'line-clamp-6')}>
        {entry.text}
      </div>
      {long ? (
        <button
          type="button"
          className="text-foreground-link mt-1 text-[11px] hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Daha az göster' : 'Devamını göster'}
        </button>
      ) : null}
    </div>
  );
}

function FeedTool({ entry }: { entry: Extract<SubagentFeedEntry, { kind: 'tool' }> }) {
  return (
    <div
      className="flex min-w-0 items-start gap-1.5 py-0.5 text-xs"
      style={{ paddingLeft: `${entry.depth * 12}px` }}
    >
      <span className="mt-0.5 shrink-0">
        {entry.status === 'running' ? (
          <Loader2 className="size-3 animate-spin text-foreground-muted" />
        ) : entry.status === 'error' ? (
          <XCircle className="size-3 text-foreground-destructive" />
        ) : (
          <Check className="size-3 text-foreground-muted" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground">{entry.title}</span>
        {entry.detail ? (
          <span className="block truncate font-mono text-[11px] text-foreground-muted">
            {entry.detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function SubagentFeed({ entries, empty }: { entries: SubagentFeedEntry[]; empty: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const visible = entries.length > MAX_FEED_ENTRIES ? entries.slice(-MAX_FEED_ENTRIES) : entries;
  const lastEntryId = visible.at(-1)?.id;

  // Kullanıcı yukarı kaydırmadıysa akış en altta kalır.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [visible.length, lastEntryId]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      onScroll={(event) => {
        const element = event.currentTarget;
        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {visible.length === 0 ? (
        <div className="py-6 text-center text-xs text-foreground-muted">{empty}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((entry) =>
            entry.kind === 'message' ? (
              <FeedMessage key={entry.id} entry={entry} />
            ) : entry.kind === 'thinking' ? (
              <div key={entry.id} className="flex items-center gap-1.5 py-0.5 text-xs">
                <Loader2 className="size-3 animate-spin text-foreground-muted" />
                <span className="text-foreground-muted">Düşünüyor…</span>
              </div>
            ) : (
              <FeedTool key={entry.id} entry={entry} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function usePolledEntries(read: () => SubagentFeedEntry[], deps: unknown[]): SubagentFeedEntry[] {
  const [entries, setEntries] = useState<SubagentFeedEntry[]>(() => read());
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    const tick = () => {
      const next = readRef.current();
      setEntries((previous) =>
        previous.length === next.length &&
        previous.every((entry, index) => JSON.stringify(entry) === JSON.stringify(next[index]))
          ? previous
          : next
      );
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-deps
  }, deps);
  return entries;
}

/** Yerel alt ajanın alt adımları, şef sohbetinin dökümünden okunur. */
function NativeSubagentFeed({ store, toolCallId }: { store: AcpChatStore; toolCallId: string }) {
  const entries = usePolledEntries(() => {
    const node = findToolNode(transcriptTurns(store.chatState.transcript.state), toolCallId);
    return node && 'children' in node && node.children ? toolFeedEntries(node.children) : [];
  }, [store, toolCallId]);
  return <SubagentFeed entries={entries} empty="Alt ajanın adımları burada görünecek." />;
}

/** Orkestra işçisinin kendi sohbeti; depo referans sayılarak alınır ve bırakılır. */
function WorkerFeed({
  projectId,
  taskId,
  workerId,
}: {
  projectId: string;
  taskId: string;
  workerId: string;
}) {
  const [workerStore, setWorkerStore] = useState<AcpChatStore | null>(null);
  useEffect(() => {
    const manager = getAcpChatResourceManager(taskId, projectId);
    const acquired = manager.acquire(workerId);
    acquired.bootstrap();
    setWorkerStore(acquired);
    return () => {
      setWorkerStore(null);
      manager.release(workerId);
    };
  }, [projectId, taskId, workerId]);
  const entries = usePolledEntries(
    () =>
      workerStore ? transcriptFeed(transcriptTurns(workerStore.chatState.transcript.state)) : [],
    [workerStore]
  );
  return <SubagentFeed entries={entries} empty="İşçinin sohbeti yükleniyor…" />;
}

export const SubagentSidePanel = observer(function SubagentSidePanel({
  target,
  store,
  links,
  onClose,
}: {
  target: SubagentTarget;
  store: AcpChatStore;
  links: OrchestraWorkerLinks;
  onClose: () => void;
}) {
  const isWorker = target.source === 'orchestra-worker';
  const worker = isWorker ? links.workerFor(target.toolCallId) : null;
  const [nativePhase, setNativePhase] = useState<SubagentPhase | undefined>(undefined);

  useEffect(() => {
    if (isWorker) return;
    const tick = () => {
      const node = findToolNode(
        transcriptTurns(store.chatState.transcript.state),
        target.toolCallId
      );
      setNativePhase(
        node && node.kind === 'spawn-subagent-tool-call' ? nativeSubagentPhase(node) : undefined
      );
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [isWorker, store, target.toolCallId]);

  const phase = isWorker ? links.phaseFor(target.toolCallId) : nativePhase;
  const subtitle = isWorker
    ? [worker?.agentName, worker?.modelName].filter(Boolean).join(' · ') || 'Orkestra işçisi'
    : 'Alt ajan';

  const openInSplit = () => {
    if (!worker) return;
    getTaskComposition(store.projectId, store.taskId)?.paneLayout.open(
      'acp-chat',
      { conversationId: worker.workerId },
      { preview: false, target: 'right' }
    );
  };

  return (
    <aside
      className="flex h-full w-[340px] max-w-[45%] min-w-[260px] shrink-0 flex-col border-l border-border bg-(--em-surface)"
      aria-label="Alt ajan paneli"
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <span className="mt-0.5">
          <PhaseIcon phase={phase} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground" title={target.name}>
            {target.name || (isWorker ? 'Orkestra işçisi' : 'Alt ajan')}
          </div>
          <div className="truncate text-xs text-foreground-muted">
            {subtitle}
            {phase ? ` · ${PHASE_LABEL[phase]}` : ''}
          </div>
        </div>
        {isWorker && worker ? (
          <Button
            variant="ghost"
            size="xs"
            icon
            aria-label="Tam sohbeti sağ bölmede aç"
            title="Tam sohbeti sağ bölmede aç"
            onClick={openInSplit}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label="Paneli kapat"
          title="Paneli kapat"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {isWorker ? (
        worker ? (
          <WorkerFeed
            projectId={store.projectId}
            taskId={store.taskId}
            workerId={worker.workerId}
          />
        ) : (
          <SubagentFeed entries={[]} empty="İşçi bağlanıyor…" />
        )
      ) : (
        <NativeSubagentFeed store={store} toolCallId={target.toolCallId} />
      )}
    </aside>
  );
});

/** Yazı kutusunun üstünde, çalışan alt ajanları gösteren ve tıklanınca paneli açan çip. */
export function SubagentRunningChip({
  running,
  onOpen,
}: {
  running: SubagentTarget[];
  onOpen: (target: SubagentTarget) => void;
}) {
  const first = running[0];
  if (!first) return null;
  const label =
    running.length === 1 ? '1 alt ajan çalışıyor' : `${running.length} alt ajan çalışıyor`;
  return (
    <button
      type="button"
      className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm hover:text-foreground"
      onClick={() => onOpen(first)}
      title={running.map((target) => target.name).join('\n')}
    >
      <Loader2 className="size-3 shrink-0 animate-spin" />
      <span className="truncate">{label}</span>
      <span className="text-foreground-link flex shrink-0 items-center">
        İzle
        <ChevronRight className="size-3" />
      </span>
    </button>
  );
}
