import type { Logger } from '@orkestra/shared/logger';
import type { LeasedLiveModelProvider } from '@orkestra/wire/rpc';
import { cell, expose, peek, type Cell } from '@orkestra/wire/state';
import { logHealthContract, type LogHealthReport, type RevealLogFileResult } from '../api/contract';
import { IncrementalLogReader } from './incremental-log-reader';
import { LogHealthAggregator } from './log-health-aggregator';
import { parseLogLine } from './log-line-parser';

const DAY_MS = 24 * 60 * 60 * 1000;

export type LogHealthHost = {
  /** Etkin günlük dosyasının yolu (henüz bilinmiyorsa undefined). */
  logFilePath: () => string | undefined;
  /** Dosyayı işletim sisteminin dosya yöneticisinde gösterir. */
  revealInFolder: (path: string) => void;
};

export type LogHealthServiceOptions = {
  host: LogHealthHost;
  logger?: Pick<Logger, 'warn'>;
  now?: () => number;
  /** Süreç başlangıcı (ms). Varsayılan: `Date.now() - process.uptime()`. */
  sessionStartedAt?: number;
  windowDays?: number;
  /** Başlangıç taramasında okunacak toplam bayt üst sınırı. */
  maxInitialBytes?: number;
  /** Başlangıç taramasında bakılacak döndürülmüş dosya sayısı. */
  rotatedFiles?: number;
  maxGroups?: number;
  /** Açılışı yavaşlatmamak için ilk taramadan önce beklenecek süre. */
  initialDelayMs?: number;
  pollIntervalMs?: number;
  /** Canlı modele yayın sıklığı üst sınırı. */
  publishThrottleMs?: number;
};

const DEFAULTS = {
  windowDays: 7,
  maxInitialBytes: 16 * 1024 * 1024,
  rotatedFiles: 5,
  maxGroups: 200,
  initialDelayMs: 8_000,
  pollIntervalMs: 5_000,
  publishThrottleMs: 1_000,
} as const;

/**
 * Günlük sağlığı servisi: dosyayı açılışta sınırlı bir pencerede tarar, sonra
 * artımlı olarak izler ve warn/error gruplarını canlı model olarak yayınlar.
 * Yeni hiçbir veri diske yazılmaz; durum tamamen bellektedir.
 */
export class LogHealthService {
  private readonly now: () => number;
  private readonly sessionStartedAt: number;
  private readonly windowDays: number;
  private readonly aggregator: LogHealthAggregator;
  private readonly reportCell: Cell<LogHealthReport>;
  private readonly provider: LeasedLiveModelProvider<typeof logHealthContract.report>;
  private reader: IncrementalLogReader | undefined;
  private readerPath: string | undefined;
  private truncated = false;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPublishedAt = 0;
  private running: Promise<void> | undefined;
  private readFailureReported = false;
  private disposed = false;

  constructor(private readonly options: LogHealthServiceOptions) {
    this.now = options.now ?? Date.now;
    this.sessionStartedAt =
      options.sessionStartedAt ?? Math.round(this.now() - process.uptime() * 1000);
    this.windowDays = options.windowDays ?? DEFAULTS.windowDays;
    this.aggregator = new LogHealthAggregator({
      windowMs: this.windowDays * DAY_MS,
      maxGroups: options.maxGroups ?? DEFAULTS.maxGroups,
      sessionStartedAt: this.sessionStartedAt,
      now: this.now,
    });
    this.reportCell = cell<LogHealthReport>(this.buildReport('idle'));
    this.provider = expose(logHealthContract.report, { report: this.reportCell });
  }

  feedHost(): LeasedLiveModelProvider<typeof logHealthContract.report> {
    return this.provider;
  }

  /** Gecikmeli ilk taramayı ve periyodik izlemeyi başlatır. */
  start(): void {
    if (this.disposed || this.startTimer || this.pollTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.refresh();
      this.pollTimer = setInterval(
        () => void this.refresh(),
        this.options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
      );
      this.pollTimer.unref?.();
    }, this.options.initialDelayMs ?? DEFAULTS.initialDelayMs);
    this.startTimer.unref?.();
  }

  /** Bir tarama/izleme turu çalıştırır; eşzamanlı çağrılar aynı turu paylaşır. */
  refresh(): Promise<void> {
    this.running ??= this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  snapshot(): LogHealthReport {
    return peek(this.reportCell);
  }

  revealLogFile(): RevealLogFileResult {
    const path = this.options.host.logFilePath();
    if (!path) return { success: false, error: 'Günlük dosyası bulunamadı.' };
    try {
      this.options.host.revealInFolder(path);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.startTimer = undefined;
    this.pollTimer = undefined;
    this.publishTimer = undefined;
    void this.provider.dispose();
  }

  private async runOnce(): Promise<void> {
    if (this.disposed) return;
    const path = this.options.host.logFilePath();
    if (!path) {
      this.publish('unavailable', true);
      return;
    }

    try {
      if (!this.reader || this.readerPath !== path) {
        this.reader = new IncrementalLogReader(path);
        this.readerPath = path;
        this.aggregator.clear();
        this.publish('scanning', true);
        const result = await this.reader.readInitial(
          this.options.maxInitialBytes ?? DEFAULTS.maxInitialBytes,
          this.options.rotatedFiles ?? DEFAULTS.rotatedFiles,
          (lines) => this.ingestLines(lines)
        );
        this.truncated = result.truncated;
        this.aggregator.prune();
        this.publish('ready', true);
        return;
      }

      let changed = false;
      await this.reader.readNew((lines) => {
        if (this.ingestLines(lines)) changed = true;
      });
      if (this.aggregator.prune()) changed = true;
      if (changed) this.publish('ready', false);
      this.readFailureReported = false;
    } catch (error) {
      // Kendi uyarımızın her turda yeniden gruplanmasını önlemek için bir kez bildir.
      if (!this.readFailureReported) {
        this.readFailureReported = true;
        this.options.logger?.warn('log-health: günlük dosyası okunamadı', { error });
      }
      if (peek(this.reportCell).status === 'scanning') this.publish('ready', true);
    }
  }

  private ingestLines(lines: string[]): boolean {
    let changed = false;
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (entry && this.aggregator.ingest(entry)) changed = true;
    }
    return changed;
  }

  private publish(status: LogHealthReport['status'], immediate: boolean): void {
    if (this.disposed) return;
    const throttle = this.options.publishThrottleMs ?? DEFAULTS.publishThrottleMs;
    const elapsed = this.now() - this.lastPublishedAt;
    if (immediate || elapsed >= throttle) {
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
      this.lastPublishedAt = this.now();
      this.reportCell.set(this.buildReport(status));
      return;
    }
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish(status, true);
    }, throttle - elapsed);
    this.publishTimer.unref?.();
  }

  private buildReport(status: LogHealthReport['status']): LogHealthReport {
    return {
      status,
      logFilePath: this.options.host.logFilePath() ?? null,
      sessionStartedAt: this.sessionStartedAt,
      windowStartedAt: this.aggregator.windowStartedAt,
      windowDays: this.windowDays,
      truncated: this.truncated,
      groups: this.aggregator.snapshot(),
    };
  }
}
