import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { usageLimitsContract } from '@core/features/usage-limits/api/usage-limits';
import type { AppDb } from '@core/services/app-db/node/db';
import { ConversationUsageStatsService } from './conversation-usage-stats';
import { UsageLedgerService } from './usage-ledger-service';
import { UsageLimitsService } from './usage-limits-service';

/** Bir sağlayıcı çağrısında kullanıcının ajan ayarlarındaki ortam değişkenleri. */
type ProviderEnvSource = {
  getItemWithMeta(id: string): Promise<{ value: { env?: Record<string, string> } }>;
};

export type UsageLimitsServiceSources = {
  runtimes: Pick<RuntimeBroker, 'client'>;
  providerSettings: ProviderEnvSource;
};

// Codex app-server ve Antigravity CLI sorguları yavaş olabilir; varsayılan 30 sn yetmeyebilir.
const FETCH_TIMEOUT_MS = 60_000;

const services = new WeakMap<object, UsageLimitsService>();
const ledgers = new WeakMap<object, UsageLedgerService>();

export function usageLedgerServiceFor(db: AppDb): UsageLedgerService {
  const existing = ledgers.get(db);
  if (existing) return existing;
  const service = new UsageLedgerService(db);
  ledgers.set(db, service);
  return service;
}

/**
 * Masaüstü denetleyicilerinin paylaştığı tek önbellek: kullanım alanı denetleyicisi ve Orkestra
 * (konuşmalar denetleyicisi) aynı örneği kullanır. Çalışma zamanı aracısı uygulama boyunca tektir;
 * örnek ona bağlanır.
 */
export function usageLimitsServiceFor(sources: UsageLimitsServiceSources): UsageLimitsService {
  const existing = services.get(sources.runtimes);
  if (existing) return existing;
  const service = new UsageLimitsService({
    fetch: async (host, providerId) => {
      const runtime = await sources.runtimes.client(host);
      if (!runtime.success) throw new Error('Makinenin çalışma zamanı çözümlenemedi');
      const settings = await sources.providerSettings.getItemWithMeta(providerId);
      return runtime.data.agentConfig.accountUsage(
        { providerId, env: settings.value.env ?? {} },
        { timeoutMs: FETCH_TIMEOUT_MS }
      );
    },
    consumeResetCredit: async (host, providerId, options) => {
      const runtime = await sources.runtimes.client(host);
      if (!runtime.success) throw new Error('Makinenin çalışma zamanı çözümlenemedi');
      const settings = await sources.providerSettings.getItemWithMeta(providerId);
      return runtime.data.agentConfig.consumeResetCredit(
        {
          providerId,
          env: settings.value.env ?? {},
          ...(options?.creditId ? { creditId: options.creditId } : {}),
          ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        },
        { timeoutMs: FETCH_TIMEOUT_MS }
      );
    },
  });
  services.set(sources.runtimes, service);
  return service;
}

export function createUsageLimitsWireController(
  service: UsageLimitsService,
  ledger?: UsageLedgerService,
  db?: AppDb
): Controller {
  const convStats = db ? new ConversationUsageStatsService(db, ledger) : null;
  return createController(usageLimitsContract, {
    get: async ({ host, providerIds, force }) => ({
      providers: await service.get(host, providerIds, { force: force === true }),
    }),
    consumeResetCredit: async ({ host, providerId, creditId, idempotencyKey }) =>
      service.consumeResetCredit(host, providerId, {
        ...(creditId ? { creditId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    recordUsage: async (input) => (ledger ? ledger.record(input) : { ok: false }),
    getLedgerSummary: async ({ rangeDays }) =>
      ledger
        ? ledger.getSummary(rangeDays ?? 30)
        : {
            rangeDays: rangeDays ?? 30,
            totals: { turns: 0, tokens: 0, costUsd: 0 },
            byProvider: [],
            byDay: [],
          },
    clearLedger: async () => (ledger ? ledger.clear() : { ok: false }),
    getConversationStats: async ({ conversationId }) =>
      convStats
        ? convStats.getStats(conversationId)
        : {
            source: 'none' as const,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
  });
}
