import type { BrowserConsoleEntry } from '@core/primitives/browser/api/agent-browser';

export const CONSOLE_BUFFER_CAPACITY = 500;
const CONSOLE_MESSAGE_MAX_CHARS = 4_000;
/** Bu değerden büyük `sinceMs` mutlak zaman damgası (epoch ms), küçüğü "son N ms" sayılır. */
const EPOCH_THRESHOLD_MS = 1_000_000_000_000;
const IGNORED_MESSAGE_PREFIXES = ['%cElectron Security Warning'];

/** Electron 40 `console-message` olayının ayrıntıları (yalnızca kullandığımız alanlar). */
export type ConsoleMessageDetails = {
  level?: unknown;
  message?: unknown;
  lineNumber?: unknown;
  sourceId?: unknown;
};

export function toConsoleLevel(level: unknown): BrowserConsoleEntry['level'] {
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error')
    return level;
  if (level === 'verbose') return 'debug';
  if (level === 'warn') return 'warning';
  if (typeof level === 'number') {
    // Eski konumsal biçim: 0 verbose, 1 info, 2 warning, 3 error.
    if (level <= 0) return 'debug';
    if (level === 1) return 'info';
    if (level === 2) return 'warning';
    return 'error';
  }
  return 'info';
}

export function consoleEntryFromDetails(
  details: ConsoleMessageDetails,
  time: number
): BrowserConsoleEntry | null {
  const raw = typeof details.message === 'string' ? details.message : String(details.message ?? '');
  if (IGNORED_MESSAGE_PREFIXES.some((prefix) => raw.startsWith(prefix))) return null;
  const message =
    raw.length > CONSOLE_MESSAGE_MAX_CHARS ? `${raw.slice(0, CONSOLE_MESSAGE_MAX_CHARS)}…` : raw;
  const entry: BrowserConsoleEntry = { level: toConsoleLevel(details.level), message, time };
  if (typeof details.sourceId === 'string' && details.sourceId) entry.source = details.sourceId;
  if (typeof details.lineNumber === 'number' && details.lineNumber > 0) {
    entry.line = details.lineNumber;
  }
  return entry;
}

/** Sayfanın konsol mesajları için sabit kapasiteli halka arabellek. */
export class ConsoleBuffer {
  private entries: BrowserConsoleEntry[] = [];

  constructor(
    private readonly capacity: number = CONSOLE_BUFFER_CAPACITY,
    private readonly now: () => number = Date.now
  ) {}

  push(entry: BrowserConsoleEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /**
   * `sinceMs`: 1e12'den büyükse mutlak zaman damgası (entry.time ile karşılaştırılır), değilse
   * "son N milisaniye". `limit` en yeni N kaydı döndürür. `clear` okunduktan sonra temizler.
   */
  read(options: { sinceMs?: number; limit?: number; clear?: boolean } = {}): BrowserConsoleEntry[] {
    let result = this.entries.slice();
    const { sinceMs, limit } = options;
    if (typeof sinceMs === 'number' && Number.isFinite(sinceMs)) {
      const threshold = sinceMs >= EPOCH_THRESHOLD_MS ? sinceMs : this.now() - Math.max(0, sinceMs);
      result = result.filter((entry) => entry.time >= threshold);
    }
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      const count = Math.max(0, Math.floor(limit));
      result = count === 0 ? [] : result.slice(-count);
    }
    if (options.clear) this.entries = [];
    return result.map((entry) => ({ ...entry }));
  }

  /** Belirli bir andan sonra gelen en son hata mesajı (değerlendirme hatalarını açıklamak için). */
  latestErrorSince(time: number): BrowserConsoleEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (!entry || entry.time < time) break;
      if (entry.level === 'error') return { ...entry };
    }
    return null;
  }
}
