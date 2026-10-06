import type { LogHealthLevel } from '../api/contract';

/**
 * Günlük dosyasındaki tek bir JSON satırını ayrıştırır. İki biçim desteklenir:
 * - pino (ana süreç ve ona yönlendirilen işçiler): `level`, `time`, `proc`, `pid`, `msg`, `error`…
 * - renderer kayıtları: `timestamp`, `level`, `source: 'renderer'`, `message`, `data[]`.
 * Yalnızca warn/error/fatal kayıtları döndürülür; diğerleri ve bozuk satırlar null olur.
 */

export type ParsedLogError = {
  name: string | null;
  message: string | null;
  stack: string | null;
  code: string | null;
};

export type ParsedLogEntry = {
  level: LogHealthLevel;
  time: number;
  proc: string | null;
  pid: number | null;
  message: string;
  error: ParsedLogError | undefined;
  /** Mesaj, seviye ve zaman dışındaki ek alanlar (örnek ayrıntıları için). */
  extra: Record<string, unknown>;
};

const NUMERIC_LEVELS: Record<number, LogHealthLevel> = { 40: 'warn', 50: 'error', 60: 'fatal' };
const ERROR_FIELD_NAMES = ['error', 'err', 'cause', 'reason'] as const;
const OMITTED_EXTRA_KEYS = new Set([
  'level',
  'time',
  'timestamp',
  'msg',
  'message',
  'proc',
  'pid',
  'hostname',
  'source',
  'data',
  ...ERROR_FIELD_NAMES,
]);

// JSON.parse çağrısından önce ucuz bir ön eleme: yalnızca uyarı/hata satırları ayrıştırılır.
const CANDIDATE_PATTERN = /"level"\s*:\s*(?:"(?:warn|error|fatal)"|[456]0\b)/;

export function isCandidateLogLine(line: string): boolean {
  return CANDIDATE_PATTERN.test(line);
}

export function parseLogLine(line: string): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !isCandidateLogLine(trimmed)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const level = parseLevel(raw.level);
  if (!level) return null;

  const time = parseTime(raw.time ?? raw.timestamp);
  if (time === null) return null;

  const isRenderer = raw.source === 'renderer' && Array.isArray(raw.data);
  const data = isRenderer ? (raw.data as unknown[]) : [];
  const message = isRenderer
    ? typeof data[0] === 'string'
      ? data[0]
      : (asString(raw.message) ?? '')
    : (asString(raw.msg) ?? asString(raw.message) ?? '');

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!OMITTED_EXTRA_KEYS.has(key)) extra[key] = value;
  }
  if (isRenderer && data.length > 1) {
    const rest = data.slice(1);
    for (const value of rest) {
      if (isRecord(value)) {
        for (const [key, nested] of Object.entries(value)) {
          if (!(ERROR_FIELD_NAMES as readonly string[]).includes(key)) extra[key] = nested;
        }
      }
    }
  }

  return {
    level,
    time,
    proc: asString(raw.proc) ?? (isRenderer ? 'renderer' : null),
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    message,
    error: findError(raw) ?? findErrorInArgs(data),
    extra,
  };
}

function parseLevel(value: unknown): LogHealthLevel | null {
  if (value === 'warn' || value === 'error' || value === 'fatal') return value;
  if (typeof value === 'number') return NUMERIC_LEVELS[value] ?? null;
  return null;
}

function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function findError(record: Record<string, unknown>): ParsedLogError | undefined {
  for (const field of ERROR_FIELD_NAMES) {
    const candidate = toParsedError(record[field]);
    if (candidate) return candidate;
  }
  return undefined;
}

function findErrorInArgs(args: unknown[]): ParsedLogError | undefined {
  for (const arg of args) {
    const direct = toParsedError(arg);
    if (direct && (direct.name || direct.stack)) return direct;
    if (isRecord(arg)) {
      const nested = findError(arg);
      if (nested) return nested;
    }
  }
  return undefined;
}

function toParsedError(value: unknown): ParsedLogError | undefined {
  if (typeof value === 'string' && value.trim()) {
    return { name: null, message: value, stack: null, code: null };
  }
  if (!isRecord(value)) return undefined;
  const name = asString(value.name) ?? asString(value.type);
  const message = asString(value.message);
  if (!name && !message) return undefined;
  return {
    name,
    message,
    stack: asString(value.stack),
    code: asString(value.code) ?? (typeof value.code === 'number' ? String(value.code) : null),
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
