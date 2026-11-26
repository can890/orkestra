import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { ConversationUsageStats } from '@core/features/usage-limits/api/usage-limits';
import type { AppDb } from '@core/services/app-db/node/db';
import type { UsageLedgerService } from './usage-ledger-service';

const MAX_LOG_BYTES = 25 * 1024 * 1024;
const INDEX_TTL_MS = 20_000;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

type ModelPricingPer1M = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
};

/**
 * Model ailesine göre 1M token başına ayrıştırılmış (uncached input / cached input /
 * cache write / output) API eşdeğeri USD fiyatları.
 *
 * Not: `gemini` içinde `mini` geçtiği için `gemini` her zaman `mini`'den önce kontrol edilir.
 */
export function resolveModelPricingPer1M(
  providerId?: string | null,
  model?: string | null
): ModelPricingPer1M {
  const m = (model ?? '').toLowerCase();
  const p = (providerId ?? '').toLowerCase();

  // Anthropic / Claude ailesi
  if (m.includes('opus') || m.includes('mythos')) {
    return { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 };
  }
  if (m.includes('sonnet')) {
    return { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };
  }
  if (m.includes('haiku')) {
    return { input: 0.8, cachedInput: 0.08, cacheWrite: 1.0, output: 4 };
  }

  // Google Gemini / Antigravity ailesi (`gemini` kelimesinde `mini` geçer, önce yakala!)
  if (m.includes('gemini') || p === 'gemini' || p === 'antigravity') {
    if (m.includes('flash') || m.includes('lite')) {
      return { input: 0.3, cachedInput: 0.075, cacheWrite: 0.3, output: 2.5 };
    }
    if (m.includes('carbon') || m.includes('ultra') || m.includes('orchestrator')) {
      return { input: 3.5, cachedInput: 0.35, cacheWrite: 3.5, output: 15 };
    }
    return { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 12 };
  }

  // OpenAI / Codex ailesi
  if (m.includes('astra') || m.includes('gpt-5-pro') || m.includes('o1-pro') || m.includes('o3-pro')) {
    return { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 20 };
  }
  if (/\bmini\b|\bnano\b|gpt-.*mini|o\d-mini/.test(m)) {
    return { input: 0.4, cachedInput: 0.1, cacheWrite: 0.4, output: 1.6 };
  }
  if (
    m.includes('gpt-6') ||
    m.includes('gpt-5') ||
    m.includes('codex') ||
    m.includes('o1') ||
    m.includes('o3') ||
    p === 'codex'
  ) {
    return { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 15 };
  }

  // Diğer sağlayıcılar
  if (p === 'claude') {
    return { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 };
  }
  if (p === 'grok' || m.includes('grok')) {
    return { input: 3, cachedInput: 0.75, cacheWrite: 3, output: 15 };
  }
  if (p === 'kimi' || p === 'glm' || m.includes('kimi') || m.includes('glm')) {
    return { input: 0.6, cachedInput: 0.15, cacheWrite: 0.6, output: 2.5 };
  }

  return { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 12 };
}

export function computeComponentCostUsd(
  tokens: {
    uncachedInput: number;
    cachedInput: number;
    cacheWrite: number;
    output: number;
  },
  providerId?: string | null,
  model?: string | null
): number {
  const rate = resolveModelPricingPer1M(providerId, model);
  return (
    (Math.max(0, tokens.uncachedInput) / 1_000_000) * rate.input +
    (Math.max(0, tokens.cachedInput) / 1_000_000) * rate.cachedInput +
    (Math.max(0, tokens.cacheWrite) / 1_000_000) * rate.cacheWrite +
    (Math.max(0, tokens.output) / 1_000_000) * rate.output
  );
}

async function readTextBounded(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_LOG_BYTES) return null;
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function asNonNegInt(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? Math.trunc(val) : 0;
}

function parseClaudeUsageJsonl(raw: string): Omit<ConversationUsageStats, 'source'> | null {
  let latestCostStateUsd: number | undefined;
  let latestCostStateDurationMs: number | undefined;
  let costStateInput = 0;
  let costStateCached = 0;
  let costStateCacheWrite = 0;
  let costStateOutput = 0;
  let hasCostStateTokens = false;

  // Fallback: mesaj bazlı usage toplamı (cost-state henüz yazılmadıysa).
  let msgInput = 0;
  let msgCached = 0;
  let msgCacheWrite = 0;
  let msgOutput = 0;
  let lastModel: string | undefined;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== '{') continue;
    if (!line.includes('cost-state') && !line.includes('"usage"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === 'cost-state') {
      if (typeof obj.totalCostUSD === 'number' && Number.isFinite(obj.totalCostUSD) && obj.totalCostUSD >= 0) {
        latestCostStateUsd = obj.totalCostUSD;
      }
      const apiDur = asNonNegInt(obj.totalAPIDuration);
      const toolDur = asNonNegInt(obj.totalToolDuration);
      if (apiDur + toolDur > 0) {
        latestCostStateDurationMs = apiDur + toolDur;
      }
      if (obj.modelUsage && typeof obj.modelUsage === 'object') {
        let inSum = 0;
        let cacheReadSum = 0;
        let cacheWriteSum = 0;
        let outSum = 0;
        let topModel: string | undefined;
        let topCost = -1;
        for (const [mName, mStats] of Object.entries(obj.modelUsage as Record<string, unknown>)) {
          if (!mStats || typeof mStats !== 'object') continue;
          const s = mStats as Record<string, unknown>;
          const mIn = asNonNegInt(s.inputTokens);
          const mCacheRead = asNonNegInt(s.cacheReadInputTokens);
          const mCacheWrite = asNonNegInt(s.cacheCreationInputTokens);
          const mOut = asNonNegInt(s.outputTokens);
          inSum += mIn;
          cacheReadSum += mCacheRead;
          cacheWriteSum += mCacheWrite;
          outSum += mOut;
          const mCost = typeof s.costUSD === 'number' ? s.costUSD : mIn + mCacheRead + mOut;
          if (mCost >= topCost) {
            topCost = mCost;
            topModel = mName;
          }
        }
        if (inSum + cacheReadSum + cacheWriteSum + outSum > 0) {
          costStateInput = inSum;
          costStateCached = cacheReadSum;
          costStateCacheWrite = cacheWriteSum;
          costStateOutput = outSum;
          hasCostStateTokens = true;
          if (topModel) lastModel = topModel;
        }
      }
      continue;
    }

    const message = obj.message as Record<string, unknown> | undefined;
    if (message && typeof message === 'object') {
      if (typeof message.model === 'string' && message.model) {
        lastModel = message.model;
      }
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        msgInput += asNonNegInt(usage.input_tokens);
        msgCached += asNonNegInt(usage.cache_read_input_tokens);
        msgCacheWrite += asNonNegInt(usage.cache_creation_input_tokens);
        msgOutput += asNonNegInt(usage.output_tokens);
      }
    }
  }

  const inputTokens = hasCostStateTokens ? costStateInput : msgInput;
  const cachedInputTokens = hasCostStateTokens ? costStateCached : msgCached;
  const cacheWriteTokens = hasCostStateTokens ? costStateCacheWrite : msgCacheWrite;
  const outputTokens = hasCostStateTokens ? costStateOutput : msgOutput;
  const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;

  if (totalTokens === 0 && latestCostStateUsd === undefined) return null;

  const estimatedCostUsd =
    totalTokens > 0
      ? computeComponentCostUsd(
          {
            uncachedInput: inputTokens,
            cachedInput: cachedInputTokens,
            cacheWrite: cacheWriteTokens,
            output: outputTokens,
          },
          'claude',
          lastModel
        )
      : undefined;

  return {
    providerId: 'claude',
    ...(lastModel ? { model: lastModel } : {}),
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens,
    ...(latestCostStateUsd !== undefined ? { reportedCostUsd: latestCostStateUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(latestCostStateDurationMs !== undefined
      ? { workDurationMs: latestCostStateDurationMs }
      : {}),
  };
}

function parseCodexUsageJsonl(raw: string): Omit<ConversationUsageStats, 'source'> | null {
  let latestUsage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null = null;
  let lastModel: string | undefined;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== '{') continue;
    if (!line.includes('token_count') && !line.includes('"model"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = obj.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload === 'object') {
      if (typeof payload.model === 'string' && payload.model) {
        lastModel = payload.model;
      }
      if (payload.type === 'token_count') {
        const info = payload.info as Record<string, unknown> | undefined;
        const tot = info?.total_token_usage as Record<string, unknown> | undefined;
        if (tot && typeof tot === 'object') {
          const totalInput = asNonNegInt(tot.input_tokens);
          const cached = Math.min(totalInput, asNonNegInt(tot.cached_input_tokens));
          const cacheWrite = asNonNegInt(tot.cache_write_input_tokens);
          const output = asNonNegInt(tot.output_tokens);
          const uncachedInput = Math.max(0, totalInput - cached);
          const total =
            asNonNegInt(tot.total_tokens) || uncachedInput + cached + cacheWrite + output;
          if (total > 0) {
            latestUsage = {
              inputTokens: uncachedInput,
              cachedInputTokens: cached,
              cacheWriteTokens: cacheWrite,
              outputTokens: output,
              totalTokens: total,
            };
          }
        }
      }
    }
  }

  if (!latestUsage) return null;

  const estimatedCostUsd = computeComponentCostUsd(
    {
      uncachedInput: latestUsage.inputTokens,
      cachedInput: latestUsage.cachedInputTokens,
      cacheWrite: latestUsage.cacheWriteTokens,
      output: latestUsage.outputTokens,
    },
    'codex',
    lastModel
  );

  return {
    providerId: 'codex',
    ...(lastModel ? { model: lastModel } : {}),
    ...latestUsage,
    estimatedCostUsd,
  };
}

function parseAntigravityUsageJsonl(raw: string): Omit<ConversationUsageStats, 'source'> | null {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let lastModel: string | undefined;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== '{') continue;
    if (!line.includes('input_tokens') && !line.includes('output_tokens')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.model === 'string' && obj.model) {
      lastModel = obj.model;
    }
    inputTokens += asNonNegInt(obj.input_tokens);
    cachedInputTokens += asNonNegInt(obj.cache_read_tokens);
    outputTokens += asNonNegInt(obj.output_tokens);
  }

  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  if (totalTokens === 0) return null;

  const estimatedCostUsd = computeComponentCostUsd(
    {
      uncachedInput: inputTokens,
      cachedInput: cachedInputTokens,
      cacheWrite: 0,
      output: outputTokens,
    },
    'antigravity',
    lastModel
  );

  return {
    providerId: 'antigravity',
    ...(lastModel ? { model: lastModel } : {}),
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens,
    totalTokens,
    estimatedCostUsd,
  };
}

const EMPTY_STATS: ConversationUsageStats = {
  source: 'none',
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

/**
 * Tek bir sohbet için sağlayıcının gerçek oturum günlüklerinden (Claude cost-state,
 * Codex token_count, Antigravity transcript.jsonl) veya yerel defterden kümülatif
 * token ve USD maliyet verilerini okur.
 */
export class ConversationUsageStatsService {
  private readonly homeDir: string;
  private readonly antigravityStateDir: string;
  private claudeIndex: { builtAt: number; map: Map<string, string> } | null = null;
  private codexIndex: { builtAt: number; files: Array<{ name: string; path: string }> } | null =
    null;

  constructor(
    private readonly db: AppDb,
    private readonly ledger?: UsageLedgerService,
    options?: { homeDir?: string; antigravityStateDir?: string }
  ) {
    this.homeDir = options?.homeDir ?? homedir();
    this.antigravityStateDir =
      options?.antigravityStateDir ?? join(this.homeDir, '.orkestra', 'antigravity-acp-state');
  }

  async getStats(conversationId: string): Promise<ConversationUsageStats> {
    const convId = conversationId.trim();
    if (!convId) return EMPTY_STATS;

    const row = this.db
      .select({
        provider: conversations.provider,
        providerSessionId: conversations.providerSessionId,
        location: conversations.location,
      })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .get();

    const ledgerEntry = this.ledger?.getConversation(convId) ?? null;

    if (
      row &&
      row.location !== 'remote' &&
      row.providerSessionId &&
      SAFE_ID_RE.test(row.providerSessionId)
    ) {
      const fromLog = await this.readProviderLog(row.provider, row.providerSessionId);
      if (fromLog) {
        const reportedCostUsd =
          fromLog.reportedCostUsd !== undefined || (ledgerEntry && ledgerEntry.costUsd > 0)
            ? Math.max(fromLog.reportedCostUsd ?? 0, ledgerEntry?.costUsd ?? 0)
            : undefined;
        return {
          source: 'provider-log',
          ...fromLog,
          ...(reportedCostUsd !== undefined && reportedCostUsd > 0 ? { reportedCostUsd } : {}),
        };
      }
    }

    if (ledgerEntry && (ledgerEntry.tokens > 0 || ledgerEntry.costUsd > 0)) {
      const estimatedCostUsd =
        ledgerEntry.costUsd > 0
          ? ledgerEntry.costUsd
          : computeComponentCostUsd(
              {
                // Defter yalnız toplam bağlam artışını tuttuğu için tipik ajan oranı (%70 önbellekli girdi, %20 taze girdi, %10 çıktı).
                uncachedInput: Math.round(ledgerEntry.tokens * 0.2),
                cachedInput: Math.round(ledgerEntry.tokens * 0.7),
                cacheWrite: 0,
                output: Math.round(ledgerEntry.tokens * 0.1),
              },
              ledgerEntry.providerId,
              ledgerEntry.model
            );
      return {
        source: 'ledger',
        providerId: ledgerEntry.providerId,
        ...(ledgerEntry.model ? { model: ledgerEntry.model } : {}),
        inputTokens: ledgerEntry.tokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: ledgerEntry.tokens,
        ...(ledgerEntry.costUsd > 0 ? { reportedCostUsd: ledgerEntry.costUsd } : {}),
        estimatedCostUsd,
      };
    }

    return EMPTY_STATS;
  }

  private async readProviderLog(
    provider: string | null,
    sessionId: string
  ): Promise<Omit<ConversationUsageStats, 'source'> | null> {
    if (provider === 'claude') {
      const filePath = await this.findClaudeFile(sessionId);
      if (!filePath) return null;
      const raw = await readTextBounded(filePath);
      return raw ? parseClaudeUsageJsonl(raw) : null;
    }

    if (provider === 'codex') {
      const filePath = await this.findCodexFile(sessionId);
      if (!filePath) return null;
      const raw = await readTextBounded(filePath);
      return raw ? parseCodexUsageJsonl(raw) : null;
    }

    if (provider === 'antigravity') {
      const candidateIds = new Set<string>([sessionId]);
      const stateRaw = await readTextBounded(join(this.antigravityStateDir, `${sessionId}.json`));
      if (stateRaw) {
        try {
          const parsed = JSON.parse(stateRaw) as { nativeId?: unknown };
          if (typeof parsed.nativeId === 'string' && SAFE_ID_RE.test(parsed.nativeId)) {
            candidateIds.add(parsed.nativeId);
          }
        } catch {
          // yoksay
        }
      }
      const roots = [
        join(this.homeDir, '.gemini', 'antigravity-cli', 'brain'),
        join(this.homeDir, '.gemini', 'antigravity', 'brain'),
      ];
      for (const id of candidateIds) {
        for (const root of roots) {
          const raw = await readTextBounded(
            join(root, id, '.system_generated', 'logs', 'transcript.jsonl')
          );
          if (raw) {
            const parsed = parseAntigravityUsageJsonl(raw);
            if (parsed) return parsed;
          }
        }
      }
    }

    return null;
  }

  private async findClaudeFile(sessionId: string): Promise<string | null> {
    const now = Date.now();
    if (!this.claudeIndex || now - this.claudeIndex.builtAt > INDEX_TTL_MS) {
      const map = new Map<string, string>();
      const projectsDir = join(this.homeDir, '.claude', 'projects');
      try {
        const dirs = await readdir(projectsDir);
        for (const dir of dirs) {
          const fullDir = join(projectsDir, dir);
          let entries: string[];
          try {
            entries = await readdir(fullDir);
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (!entry.endsWith('.jsonl')) continue;
            const sid = entry.slice(0, -'.jsonl'.length);
            if (sid && !map.has(sid)) map.set(sid, join(fullDir, entry));
          }
        }
      } catch {
        // yoksay
      }
      this.claudeIndex = { builtAt: now, map };
    }
    return this.claudeIndex.map.get(sessionId) ?? null;
  }

  private async findCodexFile(sessionId: string): Promise<string | null> {
    const now = Date.now();
    if (!this.codexIndex || now - this.codexIndex.builtAt > INDEX_TTL_MS) {
      const files: Array<{ name: string; path: string }> = [];
      const root = join(this.homeDir, '.codex', 'sessions');
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push({ name: basename(entry.name), path: full });
          }
        }
      };
      await walk(root, 0);
      this.codexIndex = { builtAt: now, files };
    }
    const match = this.codexIndex.files.find(
      (f) => f.name.endsWith(`-${sessionId}.jsonl`) || f.name === `${sessionId}.jsonl`
    );
    return match?.path ?? null;
  }
}
