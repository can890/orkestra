import { redactAll } from '@orkestra/shared/logger';
import type { LogHealthExample, LogHealthGroup, LogHealthLevel } from '../api/contract';
import type { ParsedLogEntry } from './log-line-parser';
import { logGroupKey, normalizeErrorSignature, normalizeLogText } from './normalize';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_IDS = 16;
const MAX_PROCESSES = 8;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LINES = 12;
const MAX_STACK_LENGTH = 3_000;
const MAX_FIELDS_LENGTH = 3_000;

const LEVEL_RANK: Record<LogHealthLevel, number> = { warn: 1, error: 2, fatal: 3 };

export type LogHealthAggregatorOptions = {
  /** Bu süreden eski kayıtlar gruplara alınmaz ve eski gruplar budanır. */
  windowMs: number;
  /** Tutulacak en fazla grup sayısı; aşılınca en uzun süredir görülmeyen düşer. */
  maxGroups: number;
  /** Süreç başlangıcı (ms); bu andan sonraki kayıtlar oturum sayımına girer. */
  sessionStartedAt: number;
  now: () => number;
};

type MutableGroup = {
  key: string;
  level: LogHealthLevel;
  template: string;
  errorSignature: string | null;
  count: number;
  sessionCount: number;
  pids: Set<number>;
  days: Set<string>;
  firstSeen: number;
  lastSeen: number;
  processes: Set<string>;
  example: LogHealthExample;
};

/**
 * Ayrıştırılmış warn/error kayıtlarını bellekte gruplar. Diske hiçbir şey yazmaz;
 * başlangıçta günlük dosyasından yeniden kurulur.
 */
export class LogHealthAggregator {
  private readonly groups = new Map<string, MutableGroup>();

  constructor(private readonly options: LogHealthAggregatorOptions) {}

  get windowStartedAt(): number {
    return this.options.now() - this.options.windowMs;
  }

  /** Kaydı ilgili gruba ekler; pencere dışındaysa yok sayar. Değişiklik olduysa true. */
  ingest(entry: ParsedLogEntry): boolean {
    if (entry.time < this.windowStartedAt) return false;

    // Şablon ve imza da yayınlandığı için normalleştirmeden önce maskelenir.
    const template = normalizeLogText(redactAll(entry.message)) || '(mesaj yok)';
    const errorSignature = normalizeErrorSignature(
      entry.error && {
        name: entry.error.name ? redactAll(entry.error.name) : null,
        message: entry.error.message ? redactAll(entry.error.message) : null,
        code: entry.error.code,
      }
    );
    const key = logGroupKey(entry.level, template, errorSignature);
    const isSession = entry.time >= this.options.sessionStartedAt;

    const existing = this.groups.get(key);
    if (existing) {
      existing.count += 1;
      if (isSession) existing.sessionCount += 1;
      if (entry.pid !== null) addBounded(existing.pids, entry.pid, MAX_TRACKED_IDS);
      addBounded(existing.days, dayOf(entry.time), MAX_TRACKED_IDS);
      if (entry.proc) addBounded(existing.processes, entry.proc, MAX_PROCESSES);
      existing.firstSeen = Math.min(existing.firstSeen, entry.time);
      if (entry.time >= existing.lastSeen) {
        existing.lastSeen = entry.time;
        existing.example = buildExample(entry);
      }
      return true;
    }

    this.groups.set(key, {
      key,
      level: entry.level,
      template,
      errorSignature,
      count: 1,
      sessionCount: isSession ? 1 : 0,
      pids: new Set(entry.pid !== null ? [entry.pid] : []),
      days: new Set([dayOf(entry.time)]),
      firstSeen: entry.time,
      lastSeen: entry.time,
      processes: new Set(entry.proc ? [entry.proc] : []),
      example: buildExample(entry),
    });
    this.evictOverflow(key);
    return true;
  }

  /** Pencere dışına düşen grupları siler. Değişiklik olduysa true. */
  prune(): boolean {
    const cutoff = this.windowStartedAt;
    let changed = false;
    for (const [key, group] of this.groups) {
      if (group.lastSeen < cutoff) {
        this.groups.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  clear(): void {
    this.groups.clear();
  }

  get size(): number {
    return this.groups.size;
  }

  /** Önem, sıklık ve son görülmeye göre sıralı, değişmez grup listesi. */
  snapshot(): LogHealthGroup[] {
    return [...this.groups.values()]
      .map(
        (group): LogHealthGroup => ({
          key: group.key,
          level: group.level,
          template: group.template,
          errorSignature: group.errorSignature,
          count: group.count,
          sessionCount: group.sessionCount,
          launchCount: group.pids.size,
          dayCount: group.days.size,
          firstSeen: group.firstSeen,
          lastSeen: group.lastSeen,
          processes: [...group.processes].sort(),
          example: group.example,
        })
      )
      .sort(compareGroups);
  }

  private evictOverflow(protectedKey: string): void {
    while (this.groups.size > this.options.maxGroups) {
      let oldest: MutableGroup | undefined;
      for (const group of this.groups.values()) {
        if (group.key === protectedKey) continue;
        if (!oldest || group.lastSeen < oldest.lastSeen) oldest = group;
      }
      if (!oldest) return;
      this.groups.delete(oldest.key);
    }
  }
}

export function compareGroups(a: LogHealthGroup, b: LogHealthGroup): number {
  return (
    LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    b.count - a.count ||
    b.lastSeen - a.lastSeen ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Son örneği oluşturur. Satır diske yazılırken maskelenmiş olsa da her alan
 * savunma derinliği için yeniden `redactAll` taramasından geçirilir.
 */
function buildExample(entry: ParsedLogEntry): LogHealthExample {
  return {
    time: new Date(entry.time).toISOString(),
    proc: entry.proc,
    message: redactAll(truncate(entry.message, MAX_MESSAGE_LENGTH)),
    errorName: entry.error?.name ? redactAll(entry.error.name) : null,
    errorMessage: entry.error?.message
      ? redactAll(truncate(entry.error.message, MAX_MESSAGE_LENGTH))
      : null,
    stack: entry.error?.stack ? redactAll(trimStack(entry.error.stack)) : null,
    fields: formatFields(entry.extra),
  };
}

function formatFields(extra: Record<string, unknown>): string | null {
  if (Object.keys(extra).length === 0) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(extra, null, 2);
  } catch {
    return null;
  }
  return redactAll(truncate(serialized, MAX_FIELDS_LENGTH));
}

function trimStack(stack: string): string {
  return truncate(stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'), MAX_STACK_LENGTH);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function dayOf(time: number): string {
  return String(Math.floor(time / DAY_MS));
}

function addBounded<T>(set: Set<T>, value: T, max: number): void {
  if (set.has(value) || set.size >= max) return;
  set.add(value);
}
