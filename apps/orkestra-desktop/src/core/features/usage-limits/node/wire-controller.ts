import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { usageLimitsContract } from '@core/features/usage-limits/api/usage-limits';
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
  });
  services.set(sources.runtimes, service);
  return service;
}

export function createUsageLimitsWireController(service: UsageLimitsService): Controller {
  return createController(usageLimitsContract, {
    get: async ({ host, providerIds, force }) => ({
      providers: await service.get(host, providerIds, { force: force === true }),
    }),
  });
}
