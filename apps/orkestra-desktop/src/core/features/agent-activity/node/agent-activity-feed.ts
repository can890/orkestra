import type { Logger } from '@orkestra/shared/logger';
import { createEventStreamHost, type EventStreamHost } from '@orkestra/wire/live';
import {
  AGENT_ACTIVITY_MAX_SNAPSHOT_BYTES,
  agentActivityContract,
  type AgentActivityEntry,
  type AgentActivityEvent,
  type AgentActivitySnapshot,
} from '../api/contract';
import {
  applyAgentSignal,
  applyStatusChange,
  createAgentActivityModel,
  orderEntries,
  pruneAgentActivity,
  type AgentActivityChange,
  type AgentActivityContext,
  type AgentActivitySignal,
  type AgentActivityStatus,
} from './agent-activity-model';

export type AgentActivityFeedDeps = {
  /** Sohbetin proje/görev kimliği ve görüntü adlarını çözer; bilinmeyen sohbet için `null`. */
  resolveContext(input: {
    conversationId: string;
    providerId?: string;
  }): Promise<AgentActivityContext | null>;
  hostName(): string;
  /** Başlangıç yayın durumu (masaüstü ayarı; varsayılan açık). */
  publishing?: boolean;
  logger?: Pick<Logger, 'warn'>;
  now?: () => number;
  /** Saklama budaması aralığı (ms); `0` kapatır (testler). */
  pruneIntervalMs?: number;
};

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

/**
 * Ajan etkinliği akışının host tarafı: ajan durum sinyallerini saf modele uygular, telefonlara
 * snapshot + canlı olay akışı sunar. Yayın kapalıyken snapshot boştur ve olay gönderilmez
 * (yalnızca istemcilerin listeyi temizlemesi için tek bir `publishing` olayı).
 */
export class AgentActivityFeed {
  private readonly model = createAgentActivityModel();
  private readonly events: EventStreamHost<typeof agentActivityContract.events>;
  private publishing: boolean;
  private chain: Promise<void> = Promise.resolve();
  private readonly pruneTimer: ReturnType<typeof setInterval> | null;
  private disposed = false;

  constructor(private readonly deps: AgentActivityFeedDeps) {
    this.publishing = deps.publishing ?? true;
    this.events = createEventStreamHost(agentActivityContract.events);
    const interval = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    if (interval > 0) {
      this.pruneTimer = setInterval(() => this.prune(), interval);
      this.pruneTimer.unref?.();
    } else {
      this.pruneTimer = null;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  eventsHost(): EventStreamHost<typeof agentActivityContract.events> {
    return this.events;
  }

  isPublishing(): boolean {
    return this.publishing;
  }

  /** Masaüstü ayarı değişti. Kapatınca liste korunur ama dışarı verilmez. */
  setPublishing(publishing: boolean): void {
    if (this.publishing === publishing) return;
    this.publishing = publishing;
    this.emit({
      type: 'publishing',
      now: this.now(),
      publishing,
      revision: this.model.revision,
    });
  }

  /** `agentStatusService.on('agent:event')` kancası. Sırayı korumak için kuyruklanır. */
  handleAgentEvent(event: AgentActivitySignal & { providerId?: string }): Promise<void> {
    return this.enqueue(async () => {
      const context = await this.deps.resolveContext({
        conversationId: event.conversationId,
        ...(event.providerId ? { providerId: event.providerId } : {}),
      });
      if (!context) return;
      this.publishChanges(applyAgentSignal(this.model, event, context));
    });
  }

  /** `agentStatusService.on('status:changed')` kancası. */
  handleStatusChange(change: {
    conversationId: string;
    status: AgentActivityStatus;
  }): Promise<void> {
    return this.enqueue(async () => {
      const needsContext =
        !this.model.entries.has(change.conversationId) &&
        (change.status === 'working' || change.status === 'awaiting-input');
      const context = needsContext
        ? await this.deps.resolveContext({ conversationId: change.conversationId })
        : null;
      this.publishChanges(applyStatusChange(this.model, { ...change, at: this.now() }, context));
    });
  }

  /** Snapshot: sıralı, bayt bütçesine sığdırılmış. Yayın kapalıyken liste boş. */
  snapshot(): AgentActivitySnapshot {
    const base = {
      publishing: this.publishing,
      hostName: this.deps.hostName().slice(0, 64),
      now: this.now(),
      revision: this.model.revision,
    };
    if (!this.publishing) return { ...base, entries: [] };
    return {
      ...base,
      entries: fitEntriesToBudget(orderEntries([...this.model.entries.values()]), base),
    };
  }

  prune(): void {
    if (this.disposed) return;
    this.publishChanges(pruneAgentActivity(this.model, this.now()));
  }

  dispose(): void {
    this.disposed = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.events.dispose();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((error: unknown) => {
      this.deps.logger?.warn('Agent activity feed update failed', { error: String(error) });
    });
    this.chain = next;
    return next;
  }

  private publishChanges(changes: AgentActivityChange[]): void {
    if (this.disposed) return;
    const now = this.now();
    for (const change of changes) {
      if (change.kind === 'upsert') {
        this.emit({ type: 'upsert', now, entry: change.entry, alert: change.alert });
      } else {
        this.emit({
          type: 'remove',
          now,
          conversationId: change.conversationId,
          revision: change.revision,
        });
      }
    }
  }

  private emit(event: AgentActivityEvent): void {
    if (this.disposed) return;
    // Yayın kapalıyken yalnızca durum değişikliği olayı gider (istemci listeyi temizlesin).
    if (!this.publishing && event.type !== 'publishing') return;
    this.events.emit(undefined, event);
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Uzak çerçeve bütçesi: önce önizlemeler kısaltılır, yine sığmazsa listenin sonundan (en eski
 * sonuçlar) kayıt düşülür. Kayıtlar zaten sınırlı olduğu için pratikte nadiren devreye girer.
 */
export function fitEntriesToBudget(
  entries: AgentActivityEntry[],
  base: Omit<AgentActivitySnapshot, 'entries'>,
  maxBytes = AGENT_ACTIVITY_MAX_SNAPSHOT_BYTES
): AgentActivityEntry[] {
  let fitted = entries;
  if (jsonBytes({ ...base, entries: fitted }) <= maxBytes) return fitted;
  fitted = fitted.map((entry) =>
    entry.preview.length > 80 ? { ...entry, preview: `${entry.preview.slice(0, 79)}…` } : entry
  );
  while (fitted.length > 0 && jsonBytes({ ...base, entries: fitted }) > maxBytes) {
    fitted = fitted.slice(0, -1);
  }
  return fitted;
}
