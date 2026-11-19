import { buildTerminalEnv } from '@orkestra/core/services/pty/api';
import { redactAll } from '@orkestra/shared/logger';
import type { Logger } from '@orkestra/shared/logger';
import type { HookDefinition, LifecycleHooksConfig } from '../api/hook-config';
import {
  MAX_RUNS_PER_HOOK,
  RUN_OUTPUT_TAIL_CHARS,
  type HookRunRecord,
  type HookRunStatus,
} from '../api/hook-runs';
import { matchHooks, type LifecycleHookEvent } from '../api/node/hook-events';
import type { HookProcessResult, HookProcessRunner } from './hook-process-runner';

export type HookDispatcherLimits = Readonly<{
  /** Aynı anda çalışabilecek toplam kanca süreci. */
  maxConcurrentTotal: number;
  /** Kayan 60 sn penceresinde başlatılabilecek en çok süreç. */
  maxStartsPerMinute: number;
}>;

export const DEFAULT_HOOK_LIMITS: HookDispatcherLimits = {
  maxConcurrentTotal: 4,
  maxStartsPerMinute: 30,
};

const MAX_STDIN_STRING_CHARS = 20_000;
/** Env'e yalnızca bu biçimdeki denetimli kimlikler konur. */
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export type HookDispatcherDeps = {
  getConfig(): LifecycleHooksConfig;
  runner: HookProcessRunner;
  /** Yalnızca yerel projeler için kanca çalışır; SSH/uzak projelerde atlanır. */
  isLocalProject(projectId: string): Promise<boolean>;
  /** Host varsayılan `shellSetup` değeri (depo dosyalarından DEĞİL). */
  resolveShellSetup(): Promise<string | undefined>;
  /** Kabuk ortamı (kullanıcının oturum env'i); `buildTerminalEnv`'den geçirilir. */
  baseEnv(): NodeJS.ProcessEnv;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  limits?: HookDispatcherLimits;
};

/**
 * Gözlemsel kanca yürütücüsü. `emit` hiçbir zaman beklemez ya da fırlatmaz; kanca hatası
 * yalnızca günlüğe düşer. Aynı kanca için eşzamanlı çalıştırma 1 ile sınırlıdır (fazlası
 * atlanır), ayrıca genel eşzamanlılık ve dakika başına başlatma sınırı vardır.
 */
export class LifecycleHookDispatcher {
  private readonly runningHooks = new Set<string>();
  private readonly startTimes: number[] = [];
  private readonly runs = new Map<string, HookRunRecord[]>();
  private readonly pending = new Set<Promise<void>>();
  private runningTotal = 0;
  private runCounter = 0;
  private readonly now: () => number;
  private readonly limits: HookDispatcherLimits;

  constructor(private readonly deps: HookDispatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.limits = deps.limits ?? DEFAULT_HOOK_LIMITS;
  }

  /** Olayı kuyruğa alır ve hemen döner; kancalar ajan akışını beklemez. */
  emit(event: LifecycleHookEvent): void {
    queueMicrotask(() => {
      const work = this.dispatch(event).catch((error: unknown) => {
        this.deps.logger.warn('Kanca dağıtımı başarısız', { error: String(error) });
      });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
  }

  /** Testler için: bekleyen tüm dağıtımların (süreçler dahil) bitmesini bekler. */
  async idle(): Promise<void> {
    await Promise.resolve();
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  getRuns(): HookRunRecord[] {
    return [...this.runs.values()].flat().sort((a, b) => b.startedAt - a.startedAt);
  }

  clearRuns(): void {
    this.runs.clear();
  }

  /** Yapılandırmada artık bulunmayan kancaların günlüğünü atar. */
  pruneRuns(keepHookIds: ReadonlySet<string>): void {
    for (const hookId of [...this.runs.keys()]) {
      if (!keepHookIds.has(hookId)) this.runs.delete(hookId);
    }
  }

  private async dispatch(event: LifecycleHookEvent): Promise<void> {
    const matched = matchHooks(this.deps.getConfig(), event);
    if (matched.length === 0) return;
    if (!(await this.deps.isLocalProject(event.projectId))) {
      this.deps.logger.info('Kanca atlandı: proje yerel değil (SSH projelerinde çalışmaz)', {
        event: event.name,
        projectId: event.projectId,
      });
      return;
    }
    await Promise.all(matched.map((hook) => this.runOne(hook, event)));
  }

  private async runOne(hook: HookDefinition, event: LifecycleHookEvent): Promise<void> {
    const startedAt = this.now();
    const skip = (note: string) => {
      this.deps.logger.warn('Kanca atlandı', { hookId: hook.id, event: event.name, note });
      this.record(hook, event, { startedAt, durationMs: 0, status: 'skipped', note });
    };

    const env = this.buildEnv(event);
    if (!env) return skip('Olay kimlikleri geçersiz; güvenlik için çalıştırılmadı');
    if (this.runningHooks.has(hook.id)) {
      return skip('Önceki çalıştırma sürüyor (aynı kanca için eşzamanlılık sınırı 1)');
    }
    if (this.runningTotal >= this.limits.maxConcurrentTotal) {
      return skip('Genel eşzamanlılık sınırına ulaşıldı');
    }
    while (this.startTimes.length > 0 && startedAt - this.startTimes[0]! >= 60_000) {
      this.startTimes.shift();
    }
    if (this.startTimes.length >= this.limits.maxStartsPerMinute) {
      return skip('Dakika başına çalıştırma sınırına ulaşıldı');
    }

    this.runningHooks.add(hook.id);
    this.runningTotal += 1;
    this.startTimes.push(startedAt);
    try {
      let shellSetup: string | undefined;
      try {
        shellSetup = await this.deps.resolveShellSetup();
      } catch (error) {
        this.deps.logger.warn('Kanca için shellSetup okunamadı', { error: String(error) });
      }
      const result = await this.deps.runner({
        command: hook.command,
        shellSetup,
        env,
        stdin: serializeStdin(event),
        timeoutMs: hook.timeoutSec * 1000,
      });
      const durationMs = Math.max(0, this.now() - startedAt);
      const status = statusOf(result);
      if (status !== 'ok') {
        this.deps.logger.warn('Kanca başarısız', {
          hookId: hook.id,
          event: event.name,
          status,
          exitCode: result.exitCode,
        });
      }
      this.record(hook, event, {
        startedAt,
        durationMs,
        status,
        exitCode: result.exitCode,
        signal: result.signal,
        note: noteOf(result, hook),
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      });
    } catch (error) {
      this.deps.logger.warn('Kanca çalıştırıcısı hata verdi', {
        hookId: hook.id,
        error: String(error),
      });
      this.record(hook, event, {
        startedAt,
        durationMs: Math.max(0, this.now() - startedAt),
        status: 'error',
        note: 'Çalıştırıcı beklenmeyen bir hata verdi',
      });
    } finally {
      this.runningHooks.delete(hook.id);
      this.runningTotal -= 1;
    }
  }

  /** Süreç ortamı: yalnızca sabit adlı, denetimli değerler. İçerik (prompt vb.) asla konmaz. */
  private buildEnv(event: LifecycleHookEvent): Record<string, string> | null {
    const ids = [event.projectId, event.taskId, event.conversationId];
    if (ids.some((id) => id !== undefined && !SAFE_ID.test(id))) return null;
    return buildTerminalEnv({
      baseEnv: this.deps.baseEnv(),
      overrides: {
        ORKESTRA_HOOK_EVENT: event.name,
        ORKESTRA_TASK_ID: event.taskId,
        ORKESTRA_PROJECT_ID: event.projectId,
        ORKESTRA_CONVERSATION_ID: event.conversationId,
      },
    });
  }

  private record(
    hook: HookDefinition,
    event: LifecycleHookEvent,
    partial: {
      startedAt: number;
      durationMs: number;
      status: HookRunStatus;
      exitCode?: number | null;
      signal?: string | null;
      note?: string | null;
      stdoutTail?: string;
      stderrTail?: string;
    }
  ): void {
    this.runCounter += 1;
    const record: HookRunRecord = {
      id: `${partial.startedAt}-${this.runCounter}`,
      hookId: hook.id,
      event: event.name,
      startedAt: partial.startedAt,
      durationMs: partial.durationMs,
      status: partial.status,
      exitCode: partial.exitCode ?? null,
      signal: partial.signal ?? null,
      note: partial.note ?? null,
      stdoutTail: sanitizeTail(partial.stdoutTail ?? ''),
      stderrTail: sanitizeTail(partial.stderrTail ?? ''),
    };
    const list = this.runs.get(hook.id) ?? [];
    list.unshift(record);
    if (list.length > MAX_RUNS_PER_HOOK) list.length = MAX_RUNS_PER_HOOK;
    this.runs.set(hook.id, list);
  }
}

function statusOf(result: HookProcessResult): HookRunStatus {
  if (result.spawnError) return 'error';
  if (result.timedOut) return 'timeout';
  return result.exitCode === 0 ? 'ok' : 'failed';
}

function noteOf(result: HookProcessResult, hook: HookDefinition): string | null {
  if (result.spawnError) return `Süreç başlatılamadı: ${redactAll(result.spawnError)}`;
  if (result.timedOut) return `${hook.timeoutSec} sn zaman aşımı doldu; süreç sonlandırıldı`;
  return null;
}

/** Çıktı kuyruğu: denetim karakterleri ayıklanır, kırpılır ve gizli bilgiler maskelenir. */
function sanitizeTail(value: string): string {
  const stripped = value.replace(ANSI, '').replace(/\r/g, '');
  const tail =
    stripped.length > RUN_OUTPUT_TAIL_CHARS
      ? stripped.slice(stripped.length - RUN_OUTPUT_TAIL_CHARS)
      : stripped;
  return redactAll(tail);
}

function clip(value: string | number | boolean | null | undefined) {
  if (typeof value === 'string' && value.length > MAX_STDIN_STRING_CHARS) {
    return `${value.slice(0, MAX_STDIN_STRING_CHARS)}…`;
  }
  return value;
}

/** Olay verisinin tek çıkış yolu: stdin JSON'u. */
export function serializeStdin(event: LifecycleHookEvent): string {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    if (value !== undefined) data[key] = clip(value);
  }
  return JSON.stringify({
    event: event.name,
    occurredAt: new Date(event.occurredAt).toISOString(),
    projectId: event.projectId,
    taskId: event.taskId,
    ...(event.conversationId !== undefined ? { conversationId: event.conversationId } : {}),
    data,
  });
}
