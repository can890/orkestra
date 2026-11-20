import { execFile, spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AccountUsage } from '../../api/account-usage';
import {
  claudeCredentialInfo,
  claudeGlobalConfigPath,
  readClaudeUsageCache,
  readCodexSessionRateLimits,
} from './account-usage-fallbacks';
import { readGrokBillingWindow } from './grok-billing';

const exec = promisify(execFile);
// Provider responses are untrusted; only finite, explicitly supplied measurements are displayed.
type Payload = Record<string, any>;
const number = (v: unknown): number | undefined =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : undefined;
const date = (v: unknown): string | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};
const sources: Record<string, string> = {
  claude: 'Anthropic OAuth kullanım API’si',
  codex: 'Codex CLI · account/rateLimits/read',
  kimi: 'Kimi Code kullanım API’si',
  grok: 'Grok CLI faturalama API’si',
  glm: 'Z.ai Coding Plan kota API’si',
  antigravity: 'Antigravity CLI · /usage',
};
export function parseAccountUsage(providerId: string, data: Payload): AccountUsage {
  const result: AccountUsage = {
    providerId,
    checkedAt: new Date().toISOString(),
    source: sources[providerId] ?? providerId,
    status: 'unavailable',
    windows: [],
    balances: [],
  };
  const add = (label: string, used: unknown, reset?: unknown) => {
    const n = number(used);
    if (n === undefined || n < 0 || n > 100) return;
    result.windows.push({ label, remainingPercent: 100 - n, resetsAt: date(reset) });
  };
  const balance = (label: string, value: unknown, unit: string) => {
    const n = number(value);
    if (n !== undefined && n >= 0) result.balances.push({ label, value: n, unit });
  };
  if (providerId === 'claude') {
    for (const [key, label] of Object.entries({
      five_hour: '5 saatlik kota',
      seven_day: 'Haftalık kota',
      seven_day_sonnet: 'Sonnet · haftalık',
      seven_day_opus: 'Opus · haftalık',
    }))
      add(label, data[key]?.utilization, data[key]?.resets_at);
    for (const item of data.limits ?? [])
      if (item.kind === 'weekly_scoped' && item.scope?.model?.display_name)
        add(`${item.scope.model.display_name} · haftalık`, item.percent, item.resets_at);
    // A spend cap is not a credit balance. Only the explicit balance may be called a balance.
    const b = data.spend?.balance;
    if (number(b?.amount_minor) !== undefined && number(b?.exponent) !== undefined && b?.currency)
      balance('Ek kullanım bakiyesi', b.amount_minor / 10 ** b.exponent, b.currency);
    if (data.extra_usage?.is_enabled === false)
      result.message = 'Ek ücretli kullanım kapalı. Abonelik kotası yukarıda gösterilir.';
  } else if (providerId === 'grok') {
    const c = data.config;
    add('Dönem kotası', c?.creditUsagePercent, c?.currentPeriod?.end ?? c?.billingPeriodEnd);
    for (const p of c?.productUsage ?? []) add(p.product, p.usagePercent, c?.currentPeriod?.end);
    // Grok's monetary val fields are cents, separate from the percentage quota.
    if (number(c?.prepaidBalance?.val) !== undefined)
      balance('Ek kullanım kredisi (abonelikten ayrı)', c.prepaidBalance.val / 100, 'USD');
    if (!result.windows.length && c)
      result.message =
        'Haftalık abonelik kotası şu anda alınamıyor. Ek kredi bakiyesinin 0 olması abonelik kotasının bittiği anlamına gelmez.';
  } else if (providerId === 'codex') {
    const limits =
      data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
        ? Object.values(data.rateLimitsByLimitId)
        : data.rateLimits
          ? [data.rateLimits]
          : [];
    for (const raw of limits) {
      const limit = raw as Payload;
      for (const w of [limit.primary, limit.secondary])
        if (w) {
          const mins = number(w.windowDurationMins);
          const label =
            mins === 10080
              ? 'Haftalık'
              : mins === 300
                ? '5 saatlik'
                : mins
                  ? `${mins} dakikalık`
                  : 'Dönem';
          add(
            `${limit.limitName ?? limit.limitId ?? 'Codex'} · ${label}`,
            w.usedPercent,
            number(w.resetsAt) === undefined ? undefined : w.resetsAt * 1000
          );
        }
      if (!result.plan && typeof limit.planType === 'string' && limit.planType)
        result.plan = limit.planType;
      if (limit.credits?.unlimited === true)
        result.message = 'Sağlayıcı kredi kullanımını sınırsız olarak bildiriyor.';
      else
        balance(
          `${limit.limitName ?? limit.limitId ?? 'Codex'} · kredi bakiyesi`,
          limit.credits?.balance,
          'kredi'
        );
    }
    balance(
      'Kullanılabilir limit sıfırlama hakkı',
      data.rateLimitResetCredits?.availableCount,
      'adet'
    );
  } else if (providerId === 'antigravity') {
    if (data.status === 'SUCCESS' && data.command?.name === 'usage')
      for (const group of data.command.data?.groups ?? [])
        for (const b of group.buckets ?? []) {
          const remaining = number(b.remaining_fraction);
          if (remaining !== undefined && remaining >= 0 && remaining <= 1) {
            const rawName = String(b.name ?? '');
            const windowLabel =
              b.window === 'weekly'
                ? 'Haftalık'
                : /five\s*hour/i.test(rawName)
                  ? '5 saatlik'
                  : rawName || 'Kota';
            add(`${group.name} · ${windowLabel}`, (1 - remaining) * 100, b.reset_time);
          }
        }
  } else if (providerId === 'kimi') {
    const counts = (label: string, d: Payload | undefined) => {
      const total = number(d?.limit),
        remaining = number(d?.remaining),
        used = number(d?.used);
      if (total !== undefined && total > 0 && (remaining !== undefined || used !== undefined))
        add(
          label,
          remaining !== undefined ? (100 * (total - remaining)) / total : (100 * used!) / total,
          d?.resetTime
        );
    };
    const ratio = (label: string, d: Payload | undefined) => {
      const usedRatio = number(d?.used_ratio);
      if (usedRatio !== undefined && usedRatio >= 0 && usedRatio <= 1) {
        add(label, usedRatio * 100, d?.reset_time ?? d?.resetTime);
      }
    };
    if (data.usages && typeof data.usages === 'object') {
      ratio('5 saatlik kota', data.usages.limit_5h);
      ratio('Aylık kod kotası', data.usages.limit_month_code);
      ratio('Aylık toplam kota', data.usages.limit_month_total);
    }
    if (!result.windows.length) {
      counts('Haftalık kota', data.usage);
      for (const w of data.limits ?? []) {
        const dur = number(w.window?.duration);
        const unit = w.window?.timeUnit;
        const label =
          unit === 'TIME_UNIT_MINUTE' && dur === 300
            ? '5 saatlik kota'
            : `${w.window?.duration ?? ''} ${unit === 'TIME_UNIT_MINUTE' ? 'dakikalık' : 'dönem'} kota`;
        counts(label, w.detail);
      }
    }
  } else if (providerId === 'glm' && data.success !== false) {
    for (const l of data.data?.limits ?? []) {
      if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(l.type)) continue;
      let used = number(l.percentage);
      const total = number(l.usage),
        current = number(l.currentValue),
        remaining = number(l.remaining);
      if (total !== undefined && total > 0 && (current !== undefined || remaining !== undefined))
        used = (100 * (current ?? total - remaining!)) / total;
      add(
        l.type === 'TIME_LIMIT'
          ? 'MCP kotası'
          : `Coding Plan · ${l.number ?? ''} ${l.unit ?? 'dönem'}`,
        used,
        l.nextResetTime
      );
    }
  }
  if (result.windows.length || result.balances.length) result.status = 'available';
  else result.message = 'Sağlayıcı bu oturum için okunabilir kota veya bakiye verisi döndürmedi.';
  return result;
}

class UsageError extends Error {
  constructor(
    readonly kind: AccountUsage['status'],
    message: string
  ) {
    super(message);
  }
}
/** Hata nedeninin kısa, yol ve gizli bilgi içermeyen açıklaması. */
function usageFailure(error: unknown): string {
  return error instanceof UsageError ? error.message.replace(/\.$/, '') : 'bağlantı hatası';
}
async function jsonFile(path: string): Promise<Payload> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new UsageError('auth-required', 'Bu makinede okunabilir hesap oturumu bulunamadı.');
  }
}
async function request(
  url: string,
  token: string | undefined,
  headers: Record<string, string> = {}
) {
  if (!token)
    throw new UsageError(
      'auth-required',
      'Bu hesap için kullanım verisine erişen oturum bulunamadı.'
    );
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 401 || response.status === 403)
    throw new UsageError(
      'auth-required',
      'Oturumun kullanım verisine erişimi yok veya süresi dolmuş. Ajan hesabını yenileyin.'
    );
  if (!response.ok)
    throw new UsageError(
      'error',
      `Sağlayıcı kullanım sorgusunu yanıtlayamadı (HTTP ${response.status}).`
    );
  return (await response.json()) as Payload;
}
async function codexUsage(cli: string, env: Record<string, string>, cwd: string): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '',
      done = false;
    const finish = (error?: Error, value?: Payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref();
      child.once('exit', () => clearTimeout(force));
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new UsageError('error', 'Codex kullanım sorgusu zaman aşımına uğradı.')),
      25000
    );
    const send = (id: number, method: string, params: object) =>
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    child.on('error', () => finish(new UsageError('error', 'Codex CLI başlatılamadı.')));
    child.stdin.on('error', () => finish(new UsageError('error', 'Codex bağlantısı kapandı.')));
    child.on('exit', () => {
      if (!done) finish(new UsageError('error', 'Codex kullanım bağlantısı kapandı.'));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024)
        return finish(new UsageError('error', 'Kullanım yanıtı çok büyük.'));
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'),
          line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const data = JSON.parse(line);
          if (data.id === 1) {
            if (data.error)
              return finish(new UsageError('error', 'Codex kullanım bağlantısı kurulamadı.'));
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
            send(2, 'account/rateLimits/read', {});
          } else if (data.id === 2) {
            if (data.error)
              return finish(
                new UsageError('auth-required', 'Codex oturumu kullanım limitlerini paylaşmıyor.')
              );
            finish(undefined, data.result);
          }
        } catch {
          /* Ignore non-protocol diagnostic lines. */
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'orkestra_usage', version: '1.0.0' } });
  });
}
const KIMI_OAUTH_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

async function refreshOAuthToken(
  tokenUrl: string,
  refreshToken: string | undefined,
  clientId: string | undefined
): Promise<string | undefined> {
  if (!refreshToken || !clientId) return undefined;
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as Payload;
    return typeof data.access_token === 'string' && data.access_token
      ? data.access_token
      : undefined;
  } catch {
    return undefined;
  }
}

function isIsoOrEpochExpired(value: unknown, skewMs = 60_000): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return ms <= Date.now() + skewMs;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed <= Date.now() + skewMs;
  }
  return false;
}

export async function readAccountUsage(
  providerId: string,
  cli: string | undefined,
  env: Record<string, string>,
  home: string
): Promise<AccountUsage> {
  const empty = parseAccountUsage(providerId, {});
  try {
    let payload: Payload;
    if (providerId === 'claude') {
      const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
      let plan: string | undefined;
      try {
        // Dosya ve (macOS'ta) Anahtar Zinciri adaylarını birlikte kontrol et; eski/boş dosya
        // varsa geçerli Anahtar Zinciri belirtecini gölgelemesin.
        const candidates: Payload[] = [];
        try {
          candidates.push(await jsonFile(join(dir, '.credentials.json')));
        } catch {
          // Dosya yoksa Anahtar Zinciri'ne devam edilir.
        }
        if (process.platform === 'darwin' && !env.CLAUDE_CONFIG_DIR) {
          try {
            const { stdout } = await exec(
              '/usr/bin/security',
              ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
              { timeout: 10000, maxBuffer: 1024 * 1024 }
            );
            candidates.push(JSON.parse(stdout));
          } catch {
            // Anahtar Zinciri girdisi yoksa mevcut adaylarla devam edilir.
          }
        }
        const infos = candidates.map((c) => claudeCredentialInfo(c));
        const auth =
          infos.find((i) => i.token && !i.expired) ?? infos.find((i) => i.token) ?? infos[0];
        if (!env.CLAUDE_CODE_OAUTH_TOKEN && !auth) {
          throw new UsageError('auth-required', 'Bu makinede okunabilir hesap oturumu bulunamadı.');
        }
        plan = auth?.plan;
        if (!env.CLAUDE_CODE_OAUTH_TOKEN && (!auth?.token || auth.expired))
          throw new UsageError(
            'auth-required',
            'Claude Code oturumu kapalı veya süresi dolmuş; terminalde "claude /login" ile giriş yapın.'
          );
        payload = await request(
          'https://api.anthropic.com/api/oauth/usage',
          env.CLAUDE_CODE_OAUTH_TOKEN || auth?.token,
          { 'anthropic-beta': 'oauth-2025-04-20' }
        );
      } catch (error) {
        // Canlı sorgu yapılamadıysa Claude Code'un kendi /usage önbelleği gösterilir; ölçüm
        // zamanı önbelleğin zamanıdır, tazelik kararını tüketici verir.
        const cached = await readClaudeUsageCache(claudeGlobalConfigPath(env, home));
        const parsed = cached ? parseAccountUsage('claude', cached.utilization) : null;
        if (!cached || !parsed?.windows.length) throw error;
        return {
          ...parsed,
          checkedAt: cached.measuredAt,
          source: 'Claude Code yerel önbelleği (/usage)',
          message: `Canlı sorgu yapılamadı (${usageFailure(error)}); değerler Claude Code’un son /usage önbelleğinden.`,
          ...(plan ? { plan } : {}),
        };
      }
      const parsed = parseAccountUsage(providerId, payload);
      return plan ? { ...parsed, plan } : parsed;
    } else if (providerId === 'grok') {
      const credentials = await jsonFile(join(env.GROK_HOME || join(home, '.grok'), 'auth.json'));
      const entries = Object.entries(credentials).filter(([key]) =>
        key.startsWith('https://auth.x.ai::')
      );
      if (entries.length !== 1)
        throw new UsageError('auth-required', 'Tek bir etkin Grok CLI hesabı belirlenemedi.');
      const auth = entries[0]![1];
      let accessToken: string | undefined = auth.key;
      const tryRefreshGrok = async (): Promise<string | undefined> => {
        const issuer =
          typeof auth.oidc_issuer === 'string' && auth.oidc_issuer.startsWith('https://')
            ? auth.oidc_issuer.replace(/\/$/, '')
            : 'https://auth.x.ai';
        return refreshOAuthToken(`${issuer}/oauth2/token`, auth.refresh_token, auth.oidc_client_id);
      };
      if (!accessToken || isIsoOrEpochExpired(auth.expires_at)) {
        accessToken = (await tryRefreshGrok()) ?? accessToken;
      }
      try {
        payload = await request(
          'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
          accessToken,
          { 'x-xai-token-auth': 'xai-grok-cli' }
        );
      } catch (error) {
        if (error instanceof UsageError && error.kind === 'auth-required') {
          const refreshed = await tryRefreshGrok();
          if (refreshed) {
            accessToken = refreshed;
            payload = await request(
              'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
              accessToken,
              { 'x-xai-token-auth': 'xai-grok-cli' }
            );
          } else throw error;
        } else throw error;
      }
      const parsed = parseAccountUsage(providerId, payload);
      if (!parsed.windows.length && accessToken) {
        const window = await readGrokBillingWindow(accessToken);
        if (window) {
          parsed.windows.push({
            label: window.weekly ? 'Haftalık abonelik kotası' : 'Aylık abonelik kotası',
            remainingPercent: 100 - window.usedPercent,
            resetsAt: window.resetsAt,
          });
          parsed.status = 'available';
          parsed.source = 'Grok web faturalama API’si + CLI bakiye API’si';
          parsed.message = 'Ek kullanım kredisi abonelik kotasından ayrıdır.';
        }
      }
      if (typeof auth.email === 'string') parsed.account = auth.email;
      return parsed;
    } else if (providerId === 'kimi') {
      const credentials = env.KIMI_CODE_API_KEY
        ? null
        : await jsonFile(
            join(env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'credentials/kimi-code.json')
          );
      let accessToken: string | undefined = env.KIMI_CODE_API_KEY || credentials?.access_token;
      const tryRefreshKimi = async (): Promise<string | undefined> => {
        if (env.KIMI_CODE_API_KEY || !credentials?.refresh_token) return undefined;
        const oauthHost = (env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST || '').replace(
          /\/$/,
          ''
        );
        const tokenUrl = oauthHost ? `${oauthHost}/api/oauth/token` : KIMI_OAUTH_TOKEN_URL;
        return refreshOAuthToken(tokenUrl, credentials.refresh_token, KIMI_OAUTH_CLIENT_ID);
      };
      if (
        !env.KIMI_CODE_API_KEY &&
        (!accessToken || isIsoOrEpochExpired(credentials?.expires_at))
      ) {
        accessToken = (await tryRefreshKimi()) ?? accessToken;
      }
      try {
        payload = await request('https://api.kimi.com/coding/v1/usages', accessToken);
      } catch (error) {
        if (error instanceof UsageError && error.kind === 'auth-required') {
          const refreshed = await tryRefreshKimi();
          if (refreshed) {
            payload = await request('https://api.kimi.com/coding/v1/usages', refreshed);
          } else throw error;
        } else throw error;
      }
    } else if (providerId === 'glm') {
      payload = await request(
        'https://api.z.ai/api/monitor/usage/quota/limit',
        env.ZAI_API_KEY || env.Z_AI_API_KEY
      );
      if (payload.success === false || payload.code === 401)
        throw new UsageError(
          'auth-required',
          'Z.ai bu anahtarla kota bilgisini paylaşmıyor. Coding Plan hesabını kontrol edin.'
        );
    } else if (providerId === 'codex') {
      try {
        if (!cli) throw new UsageError('unavailable', 'Bu makinede Codex CLI bulunamadı.');
        payload = await codexUsage(cli, env, home);
      } catch (error) {
        // Codex'in kendi oturum günlükleri: yalnızca Codex çalışırken yazılır, eski olabilir.
        const session = await readCodexSessionRateLimits(env.CODEX_HOME || join(home, '.codex'));
        const parsed = session ? parseAccountUsage('codex', session.payload) : null;
        if (!session || !parsed?.windows.length) throw error;
        return {
          ...parsed,
          checkedAt: session.measuredAt,
          source: 'Codex oturum günlükleri',
          message: `Canlı sorgu yapılamadı (${usageFailure(error)}); değerler Codex’in son oturum kaydından, etkin hesapla eşleştiği doğrulanamaz.`,
        };
      }
    } else if (providerId === 'antigravity') {
      if (!cli) throw new UsageError('unavailable', 'Bu makinede Antigravity CLI bulunamadı.');
      const cwd = await mkdtemp(join(tmpdir(), 'orkestra-usage-'));
      try {
        const { stdout } = await exec(cli, ['-p', '/usage', '--output-format', 'json'], {
          cwd,
          env,
          timeout: 45000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        });
        payload = JSON.parse(stdout);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    } else return empty;
    return parseAccountUsage(providerId, payload);
  } catch (error) {
    return {
      ...empty,
      status: error instanceof UsageError ? error.kind : 'error',
      message:
        error instanceof UsageError
          ? error.message
          : 'Kullanım bilgisi alınamadı. Bağlantıyı ve bu makinedeki hesap oturumunu kontrol edin.',
    };
  }
}
