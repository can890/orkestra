// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/scheduledTasks/Schedule.ts,
// apps/server/src/scheduledTasks/webhookVerification.ts, apps/server/src/scheduledTasks/webhookDedupe.ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Cron } from 'croner';
import type { ScheduleSpec, WebhookRequest, WebhookSignature } from './authoring';

/** Sunucu kapalıyken bu kadardan fazla kaçırılan günlük saat atlanır. */
export const MISSED_DAILY_GRACE_MS = 10 * 60_000;

/** `from`dan kesinlikle sonraki ilk planlı an; hiç yoksa null. */
export function nextScheduledAt(schedule: ScheduleSpec, from: number): number | null {
  switch (schedule.type) {
    case 'interval':
      return from + schedule.everyMs;
    case 'cron':
      return (
        new Cron(schedule.expr, { timezone: schedule.tz }).nextRun(new Date(from))?.getTime() ??
        null
      );
    case 'daily': {
      const weekdays = schedule.weekdays ? new Set(schedule.weekdays) : null;
      const base = new Date(from);
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + offset,
          schedule.hour,
          schedule.minute,
          0,
          0
        );
        if (candidate.getTime() <= from) continue;
        if (weekdays && !weekdays.has(candidate.getDay())) continue;
        return candidate.getTime();
      }
      return null;
    }
  }
}

/** Günlük saat, sunucu kapalıyken 10 dakikadan fazla kaçırıldıysa atlanır. */
export function isMissedRun(schedule: ScheduleSpec, dueAt: number, now: number): boolean {
  return schedule.type === 'daily' && now - dueAt > MISSED_DAILY_GRACE_MS;
}

export function describeSchedule(schedule: ScheduleSpec): string {
  switch (schedule.type) {
    case 'interval':
      return `every ${formatInterval(schedule.everyMs)}`;
    case 'cron':
      return `cron ${schedule.expr} (${schedule.tz})`;
    case 'daily': {
      const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
      return schedule.weekdays
        ? `daily ${time} on ${schedule.weekdays.join(',')}`
        : `daily ${time}`;
    }
  }
}

function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/** Gövdeyi göndericinin HMAC-SHA256 imzasıyla doğrular (ör. GitHub `X-Hub-Signature-256`). */
export function verifyWebhookSignature(input: {
  signature: WebhookSignature;
  secret: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}): boolean {
  const received = input.headers[input.signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = input.signature.prefix;
  if (prefix !== '' && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const candidate = value.slice(prefix.length);
  const tag =
    input.signature.encoding === 'hex'
      ? /^[0-9a-fA-F]+$/.test(candidate)
        ? Buffer.from(candidate, 'hex')
        : null
      : Buffer.from(candidate, 'base64');
  if (!tag || tag.length === 0) return false;
  const expected = createHmac('sha256', input.secret).update(input.body, 'utf8').digest();
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}

/** Göndericinin yeniden denemede tekrarladığı teslimat başlıkları. */
const DELIVERY_HEADERS = [
  'x-github-delivery',
  'x-gitea-delivery',
  'x-gogs-delivery',
  'x-gitlab-event-uuid',
  'x-gitlab-webhook-uuid',
  'linear-delivery',
  'idempotency-key',
  'webhook-id',
  'x-request-id',
];

/**
 * Bir isteğin çalıştırma anahtarı: önce iş akışının `key` işlevi, sonra bilinen teslimat
 * başlıkları. Aynı anahtar ikinci bir çalıştırma başlatmaz. Anahtar yoksa null.
 */
export function webhookDeliveryKey(
  request: WebhookRequest,
  key: ((request: WebhookRequest) => string | undefined) | undefined
): string | null {
  if (key) {
    const named = key(request);
    if (typeof named === 'string' && named.trim()) return `key:${hash(named.trim())}`;
  }
  for (const header of DELIVERY_HEADERS) {
    const value = request.headers[header]?.trim();
    if (value) return `${header}:${hash(value)}`;
  }
  return null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Kancanın dakikalık çalıştırma sınırı (kayan pencere). */
export class HookRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000
  ) {}

  /** Sınır aşılmadıysa isteği sayar ve true döner. */
  take(id: string, now: number): boolean {
    const recent = (this.hits.get(id) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(id, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(id, recent);
    return true;
  }
}
