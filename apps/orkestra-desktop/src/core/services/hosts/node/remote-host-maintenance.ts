import type { WireInitializeResult } from '@orkestra/core/workspace-server';
import type { Scope } from '@orkestra/shared/concurrency';
import { systemClock, type Clock, type TimerHandle } from '@orkestra/shared/scheduling';
import type {
  HostHealth,
  HostMaintenanceState,
  PruneResult,
  ServerActivity,
} from '../api/maintenance-contract';
import type { HostMaintenanceModel } from './maintenance-model';
import type { WorkspaceServerLayout } from './workspace-server/layout';
import {
  summarizeHealth,
  type RemoteHostHealthInspector,
} from './workspace-server/maintenance/host-health';
import {
  isServerIdle,
  readServerActivity,
  type ServerActivitySources,
} from './workspace-server/maintenance/server-activity';
import { compareServerVersions } from './workspace-server/maintenance/version-policy';

/** Bağlıyken kanal sürümünün yeniden denetlenme aralığı. */
export const MAINTENANCE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Güncelleme bekliyor ama sunucu meşgulse etkinliğin yeniden okunma aralığı. */
export const MAINTENANCE_BUSY_RECHECK_MS = 30 * 60_000;
/** Bağlantı hazır olduktan sonra ilk denetime kadar beklenen süre; oturumlar yerleşsin. */
export const MAINTENANCE_STARTUP_DELAY_MS = 60_000;
/** Kanal sürümü bu süre boyunca önbellekten okunur (yalnızca otomatik denetimlerde). */
const AVAILABLE_VERSION_CACHE_MS = 60 * 60_000;

export type MaintenanceAttachment = {
  handshake: WireInitializeResult;
  sources: ServerActivitySources;
};

export type RemoteHostMaintenanceDeps = {
  connectionId: string;
  scope: Scope;
  model: Pick<HostMaintenanceModel, 'get' | 'update'>;
  /** Hazır bağlantı yoksa undefined; etkinlik ve çalışan sürüm buradan okunur. */
  attachment(): MaintenanceAttachment | undefined;
  layout(signal: AbortSignal): Promise<WorkspaceServerLayout>;
  availableVersion(signal: AbortSignal): Promise<string>;
  /** Yeni sürümü kurar ve current bağlantısını çevirir; çalışan daemon'a dokunmaz. */
  install(layout: WorkspaceServerLayout, version: string, signal: AbortSignal): Promise<void>;
  /** Daemon'ı yeniden başlatır; çalışma zamanı bağlantısını gözetmen duraklatıp sürdürür. */
  restart(): Promise<void>;
  health: Pick<RemoteHostHealthInspector, 'inspect' | 'prune'>;
  autoUpdate?: boolean;
  clock?: Clock;
  intervals?: Partial<{ checkMs: number; busyRecheckMs: number; startupDelayMs: number }>;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
};

type CheckTrigger = 'auto' | 'manual';

/**
 * Bir uzak makinenin workspace-server bakımı. Sürüm denetimi ve otomatik güncelleme yalnızca
 * sunucu boştayken (ajan turu, TUI oturumu, tmux dışı terminal ya da betik yokken) yapılır;
 * meşgulse hiçbir şey kesilmez, durum "boşta olmasını bekliyor" olarak işaretlenir.
 *
 * Güncelleme iki adımdır: önce yeni sürüm çalışan daemon'a dokunmadan kurulur (indirme
 * başarısız olursa makine etkilenmez), sonra mevcut yeniden başlatma akışı kullanılır.
 */
export class RemoteHostMaintenance {
  private readonly clock: Clock;
  private readonly checkMs: number;
  private readonly busyRecheckMs: number;
  private readonly startupDelayMs: number;
  private timer: TimerHandle | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCheck: Promise<void> | undefined;
  private available: { version: string; at: number } | undefined;
  private failedAutoUpdate: { version: string; at: number } | undefined;

  constructor(private readonly deps: RemoteHostMaintenanceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.checkMs = deps.intervals?.checkMs ?? MAINTENANCE_CHECK_INTERVAL_MS;
    this.busyRecheckMs = deps.intervals?.busyRecheckMs ?? MAINTENANCE_BUSY_RECHECK_MS;
    this.startupDelayMs = deps.intervals?.startupDelayMs ?? MAINTENANCE_STARTUP_DELAY_MS;
    deps.scope.add(() => {
      void this.timer?.dispose();
      this.timer = undefined;
    });
  }

  /** Çalışma zamanı bağlantısı her hazır olduğunda (yeniden bağlanma dahil) çağrılır. */
  onReady(): void {
    const attachment = this.deps.attachment();
    if (attachment) {
      this.patch({
        runningVersion: attachment.handshake.server.appVersion,
        daemonStartedAt: attachment.handshake.server.startedAt,
      });
    }
    this.schedule(this.startupDelayMs);
  }

  check(trigger: CheckTrigger = 'manual'): Promise<void> {
    if (this.pendingCheck) return this.pendingCheck;
    const pending = this.exclusive(() => this.runCheck(trigger)).finally(() => {
      if (this.pendingCheck === pending) this.pendingCheck = undefined;
    });
    this.pendingCheck = pending;
    return pending;
  }

  inspectActivity(): Promise<ServerActivity> {
    return this.readActivity();
  }

  inspectHealth(): Promise<void> {
    return this.exclusive(async () => {
      await this.refreshHealth(true);
    });
  }

  /** Kullanıcı onaylı güncelleme: etkinlik denetimi yapılmaz. */
  updateNow(): Promise<void> {
    return this.exclusive(async () => {
      const attachment = this.requireAttachment();
      const running = attachment.handshake.server.appVersion;
      const available = await this.resolveAvailable(true);
      if (available === running) {
        this.patch({ status: 'up-to-date', availableVersion: available, error: undefined });
        return;
      }
      await this.runUpdate(running, available, false);
    });
  }

  prune(): Promise<PruneResult> {
    return this.exclusive(async () => {
      this.patch({ pruning: true });
      try {
        const signal = this.deps.scope.signal;
        const layout = await this.deps.layout(signal);
        // Silme kararı her zaman taze bir listelemeye dayanır, eski görüntüye değil.
        const health = await this.inspectFresh(layout, signal);
        const result = await this.deps.health.prune(layout, health, this.runningVersion(), signal);
        await this.refreshHealth(false, layout);
        return result;
      } finally {
        this.patch({ pruning: undefined });
      }
    });
  }

  private async runCheck(trigger: CheckTrigger): Promise<void> {
    const attachment = this.deps.attachment();
    if (!attachment) {
      if (trigger === 'manual') throw new Error('Sunucuya hazır bir bağlantı yok');
      return;
    }
    const running = attachment.handshake.server.appVersion;
    this.patch({
      status: 'checking',
      runningVersion: running,
      daemonStartedAt: attachment.handshake.server.startedAt,
    });
    try {
      let available: string;
      try {
        available = await this.resolveAvailable(trigger === 'manual');
      } catch (error) {
        this.patch({
          status: 'failed',
          lastCheckedAt: this.clock.now(),
          error: `Kanal sürümü okunamadı: ${message(error)}`,
        });
        return;
      }

      const comparison = compareServerVersions(running, available);
      const base = { availableVersion: available, lastCheckedAt: this.clock.now() };
      if (comparison !== 'update-available') {
        this.patch({
          ...base,
          status:
            comparison === 'up-to-date'
              ? 'up-to-date'
              : comparison === 'dev-build'
                ? 'dev-build'
                : 'unknown',
          activity: undefined,
          error: undefined,
        });
        return;
      }

      const activity = await this.readActivity();
      if (this.deps.autoUpdate === false) {
        this.patch({ ...base, status: 'update-available', error: undefined });
        return;
      }
      if (!isServerIdle(activity)) {
        this.patch({ ...base, status: 'waiting-for-idle', error: undefined });
        this.schedule(this.busyRecheckMs);
        return;
      }
      const failed = this.failedAutoUpdate;
      if (failed?.version === available && this.clock.now() - failed.at < this.checkMs) {
        // Aynı hedefe yapılan başarısız otomatik güncelleme dönem dolmadan yeniden denenmez;
        // hata mesajı görünür kalır ve kullanıcı "Güncelle" ile elle deneyebilir.
        this.patch({ ...base, status: 'failed' });
        return;
      }
      this.patch(base);
      await this.runUpdate(running, available, true);
    } finally {
      await this.refreshHealth(false).catch(() => {});
    }
  }

  private async runUpdate(from: string, to: string, automatic: boolean): Promise<void> {
    const signal = this.deps.scope.signal;
    this.patch({ status: 'updating', error: undefined });
    try {
      const layout = await this.deps.layout(signal);
      await this.deps.install(layout, to, signal);
      if (automatic) {
        // Kurulum sürerken yeni iş başlamış olabilir; yeniden başlatmadan önce tekrar bak.
        const activity = await this.readActivity();
        if (!isServerIdle(activity)) {
          this.patch({ status: 'waiting-for-idle' });
          this.schedule(this.busyRecheckMs);
          return;
        }
      }
      await this.deps.restart();
      this.failedAutoUpdate = undefined;
      this.patch({
        status: 'up-to-date',
        runningVersion: to,
        availableVersion: to,
        activity: undefined,
        lastUpdate: { from, to, at: this.clock.now(), automatic },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (automatic) this.failedAutoUpdate = { version: to, at: this.clock.now() };
      this.deps.logger?.warn('Workspace-server update failed', {
        connectionId: this.deps.connectionId,
        automatic,
        error: message(error),
      });
      this.patch({ status: 'failed', error: `Güncelleme başarısız: ${message(error)}` });
      if (!automatic) throw error;
    }
  }

  private async readActivity(): Promise<ServerActivity> {
    const attachment = this.requireAttachment();
    const activity = await readServerActivity(attachment.sources, { clock: this.clock });
    this.patch({ activity });
    return activity;
  }

  private async refreshHealth(rethrow: boolean, knownLayout?: WorkspaceServerLayout) {
    try {
      const signal = this.deps.scope.signal;
      const layout = knownLayout ?? (await this.deps.layout(signal));
      await this.inspectFresh(layout, signal);
    } catch (error) {
      this.patch({ healthError: message(error) });
      if (rethrow) throw error;
    }
  }

  private async inspectFresh(
    layout: WorkspaceServerLayout,
    signal: AbortSignal
  ): Promise<HostHealth> {
    const listing = await this.deps.health.inspect(layout, signal);
    const health = summarizeHealth(layout, listing, this.runningVersion(), this.clock.now());
    this.patch({ health, healthError: undefined });
    return health;
  }

  private async resolveAvailable(force: boolean): Promise<string> {
    const cached = this.available;
    if (!force && cached && this.clock.now() - cached.at < AVAILABLE_VERSION_CACHE_MS) {
      return cached.version;
    }
    const version = await this.deps.availableVersion(this.deps.scope.signal);
    this.available = { version, at: this.clock.now() };
    return version;
  }

  private runningVersion(): string | undefined {
    return (
      this.deps.attachment()?.handshake.server.appVersion ??
      this.deps.model.get(this.deps.connectionId)?.runningVersion
    );
  }

  private requireAttachment(): MaintenanceAttachment {
    const attachment = this.deps.attachment();
    if (!attachment) throw new Error('Sunucuya hazır bir bağlantı yok');
    return attachment;
  }

  private schedule(delayMs: number): void {
    if (this.deps.scope.disposed) return;
    void this.timer?.dispose();
    this.timer = this.clock.schedule(
      delayMs,
      () => {
        this.timer = undefined;
        // Bir sonraki dönemsel denetimi önce kur; meşgul durumu bunu kısaltabilir.
        this.schedule(this.checkMs);
        void this.check('auto').catch((error: unknown) => {
          this.deps.logger?.warn('Workspace-server maintenance check failed', {
            connectionId: this.deps.connectionId,
            error: message(error),
          });
        });
      },
      { unref: true }
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail
      .catch(() => {})
      .then(() => {
        this.deps.scope.signal.throwIfAborted();
        return operation();
      });
    this.tail = run.catch(() => {});
    return run;
  }

  private patch(changes: Partial<HostMaintenanceState>): void {
    if (this.deps.scope.disposed) return;
    this.deps.model.update(this.deps.connectionId, (previous) =>
      compact({ status: 'unknown', ...previous, ...changes })
    );
  }
}

function compact(state: HostMaintenanceState): HostMaintenanceState {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined)
  ) as HostMaintenanceState;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
