import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Canlı kullanım sorgusu başarısız olduğunda başvurulan salt okunur yerel kaynaklar:
 * Claude Code'un `/usage` önbelleği (`.claude.json`) ve Codex oturum günlüklerindeki
 * `rate_limits` olayları. Hiçbiri canlı değildir; ölçüm zamanı her zaman kaynağın kendi
 * zaman damgasından alınır, dosyanın değiştirilme zamanı ölçüm zamanı yerine kullanılmaz.
 */

type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Claude Code kimlik bilgisinden yalnızca kullanım sorgusu için gereken alanlar. */
export type ClaudeCredentialInfo = {
  token: string | undefined;
  /** Belirtecin süresi dolmuş: Claude Code bir sonraki çalışmasında yeniler. */
  expired: boolean;
  /** Aboneliğin türü (`pro`, `max` …); bilinmiyorsa tanımsız. */
  plan: string | undefined;
};

/** `.credentials.json` / Anahtar Zinciri içeriğinden belirteci ve planı okur; belirteci kaydetmez. */
export function claudeCredentialInfo(credentials: unknown, now = Date.now()): ClaudeCredentialInfo {
  const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
  if (!isRecord(oauth)) return { token: undefined, expired: false, plan: undefined };
  const token =
    typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : undefined;
  const expiresAt = finite(oauth.expiresAt);
  const plan =
    typeof oauth.subscriptionType === 'string' && oauth.subscriptionType
      ? oauth.subscriptionType
      : undefined;
  return { token, expired: expiresAt !== undefined && expiresAt <= now, plan };
}

/** Claude Code'un genel yapılandırma dosyası: `CLAUDE_CONFIG_DIR` varsa onun içinde, yoksa ev dizininde. */
export function claudeGlobalConfigPath(env: Record<string, string>, home: string): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(home, '.claude.json');
}

export type ClaudeUsageCache = {
  /** OAuth kullanım API'siyle aynı biçimdeki pencereler (`five_hour`, `seven_day` …). */
  utilization: Payload;
  /** Claude Code'un önbelleği doldurduğu an (ISO). */
  measuredAt: string;
};

/**
 * Claude Code'un etkileşimli `/usage` komutunun yazdığı `cachedUsageUtilization` önbelleği.
 * Yalnızca bu komut çalıştığında güncellenir; saatlerce eski olabilir, bu yüzden ölçüm zamanı
 * her zaman döndürülür ve tazelik kararını tüketici verir.
 */
export function parseClaudeUsageCache(config: unknown): ClaudeUsageCache | null {
  const cached = isRecord(config) ? config.cachedUsageUtilization : undefined;
  if (!isRecord(cached) || !isRecord(cached.utilization)) return null;
  const fetchedAtMs = finite(cached.fetchedAtMs);
  if (fetchedAtMs === undefined) return null;
  const measured = new Date(fetchedAtMs);
  if (!Number.isFinite(measured.getTime())) return null;
  return { utilization: cached.utilization, measuredAt: measured.toISOString() };
}

export async function readClaudeUsageCache(path: string): Promise<ClaudeUsageCache | null> {
  try {
    return parseClaudeUsageCache(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export type CodexSessionRateLimits = {
  /** `account/rateLimits/read` yanıtıyla aynı biçime çevrilmiş ölçüm. */
  payload: Payload;
  /** Olayın kendi zaman damgası (ISO). */
  measuredAt: string;
};

function codexWindow(raw: unknown): Payload | null {
  if (!isRecord(raw)) return null;
  return {
    usedPercent: raw.used_percent,
    windowDurationMins: raw.window_minutes,
    resetsAt: raw.resets_at,
  };
}

/**
 * Codex oturum günlüğündeki tek bir satırı çözer. Yalnızca çekirdek (`codex`) kota sınırına ait,
 * zaman damgalı `token_count` olaylarını kabul eder; diğer satırlar için null döner.
 */
export function parseCodexRateLimitLine(line: string): CodexSessionRateLimits | null {
  if (!line.includes('"rate_limits"')) return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== 'event_msg') return null;
  const payload = event.payload;
  if (!isRecord(payload) || payload.type !== 'token_count') return null;
  const limits = payload.rate_limits;
  if (!isRecord(limits)) return null;
  if (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== 'codex') {
    return null;
  }
  const stamp = typeof event.timestamp === 'string' ? new Date(event.timestamp) : null;
  if (!stamp || !Number.isFinite(stamp.getTime())) return null;
  const credits = isRecord(limits.credits) ? limits.credits : null;
  return {
    measuredAt: stamp.toISOString(),
    payload: {
      rateLimits: {
        limitId: limits.limit_id ?? 'codex',
        limitName: limits.limit_name ?? null,
        primary: codexWindow(limits.primary),
        secondary: codexWindow(limits.secondary),
        ...(credits ? { credits: { balance: credits.balance, unlimited: credits.unlimited } } : {}),
        ...(typeof limits.plan_type === 'string' ? { planType: limits.plan_type } : {}),
      },
    },
  };
}

/** Bir oturum dosyasındaki en yeni ölçüm; bozuk son satır önceki geçerli ölçümü silmez. */
export function latestCodexRateLimits(text: string): CodexSessionRateLimits | null {
  let latest: CodexSessionRateLimits | null = null;
  for (const line of text.split('\n')) {
    const parsed = parseCodexRateLimitLine(line);
    if (parsed && (!latest || parsed.measuredAt >= latest.measuredAt)) latest = parsed;
  }
  return latest;
}

const TAIL_BYTES = 2 * 1024 * 1024;

/** Büyük günlüklerin yalnızca sonunu okur; en yeni olaylar dosyanın sonundadır. */
async function readTail(path: string, maxBytes = TAIL_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Oturum dosyalarını ada göre yeniden eskiye (YYYY/MM/DD/rollout-<tarih>…) sınırlı sayıda toplar.
 * Ad sırası yalnızca aramayı sınırlar; ölçüm tazeliğini olayların zaman damgası belirler.
 */
async function newestSessionFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (files.length >= limit || depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  await walk(root, 0);
  return files;
}

/**
 * `$CODEX_HOME/sessions` altındaki en yeni oturum dosyalarından en son çekirdek kota ölçümü.
 * Codex yalnızca çalışırken yazar; ölçüm günlerce eski olabilir. Etkin hesapla eşleştiği
 * kanıtlanamaz, bu yüzden yalnızca canlı sorgu başarısız olduğunda kullanılır.
 */
export async function readCodexSessionRateLimits(
  codexHome: string,
  scanLimit = 20
): Promise<CodexSessionRateLimits | null> {
  let latest: CodexSessionRateLimits | null = null;
  for (const file of await newestSessionFiles(join(codexHome, 'sessions'), scanLimit)) {
    let text: string;
    try {
      text = await readTail(file);
    } catch {
      continue;
    }
    const found = latestCodexRateLimits(text);
    if (found && (!latest || found.measuredAt >= latest.measuredAt)) latest = found;
  }
  return latest;
}
