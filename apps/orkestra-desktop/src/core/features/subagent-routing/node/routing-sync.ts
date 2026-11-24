import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import {
  type ProviderHeadroomSample,
  type SubagentRouter,
  type SubagentRoutingPolicy,
  type SubagentRoutingSnapshot,
} from '@orkestra/core/runtimes/acp/api';
import type {
  RoutingPreview,
  RoutingPreviewRow,
} from '@core/features/subagent-routing/api/contract';
import type { SubagentRoutingSettings } from '@core/features/subagent-routing/api/routing-settings';
import { activeUsageWindows } from '@core/features/usage-limits/api/usage-capacity';
import {
  INDICATOR_USAGE_PROVIDERS,
  type ProviderUsage,
  type UsageLimitsReader,
} from '@core/features/usage-limits/api/usage-limits';

export type SubagentRoutingSyncDeps = {
  /** Köprüyle aynı kaynaktan değerlendirilen saf karar fonksiyonları. */
  router: SubagentRouter;
  settings(): Promise<SubagentRoutingSettings>;
  usage: UsageLimitsReader;
  /** Köprünün okuduğu anlık görüntü dosyası. */
  snapshotFile: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  now?: () => number;
  /** Ayar açıkken yenileme aralığı (varsayılan 3 dk; kullanım önbelleğinin TTL'iyle aynı). */
  intervalMs?: number;
  /** Kullanım ölçümü için en fazla bekleme; gelmezse önbellekteki son değer kullanılır. */
  usageWaitMs?: number;
};

const DEFAULT_INTERVAL_MS = 3 * 60_000;

/** Bir sağlayıcının bağlayıcı (en dolu) geçerli penceresinden kalan kapasite örneği. */
export function headroomSampleFromUsage(
  usage: ProviderUsage | null,
  now: number
): ProviderHeadroomSample | null {
  if (!usage) return null;
  const windows = activeUsageWindows(usage, now);
  const binding = windows.reduce<(typeof windows)[number] | null>(
    (worst, window) => (!worst || window.usedPercent > worst.usedPercent ? window : worst),
    null
  );
  if (!binding) return null;
  return {
    remainingPercent: Math.max(0, 100 - binding.usedPercent),
    windowLabel: binding.label,
    resetsAt: binding.resetsAt ?? null,
    measuredAt: usage.measuredAt,
  };
}

export function toRoutingPolicy(settings: SubagentRoutingSettings): SubagentRoutingPolicy {
  return {
    thresholdPercent: settings.thresholdPercent,
    avoidParentScarceModels: settings.avoidParentScarceModels,
    scarceModels: settings.scarceModels,
    tiers: settings.tiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      enabled: tier.enabled,
      candidates: tier.candidates.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        ...(candidate.effort ? { effort: candidate.effort } : {}),
        enabled: candidate.enabled,
      })),
    })),
  };
}

/**
 * Ayar açıkken politika + yerel makinedeki kullanım pencerelerinden anlık görüntüyü
 * `orkestra-subagents` köprüsünün okuduğu dosyaya yazar; kapalıyken dosyayı siler (köprü bugünkü
 * davranışı birebir sürdürür). Kullanım sorgusu mevcut önbellek üzerinden yapılır; ayrı bir
 * sağlayıcı yoklaması eklenmez.
 */
export class SubagentRoutingSync {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private writtenAt: number | null = null;
  private lastError: string | null = null;
  private lastHeadroom: Record<string, ProviderHeadroomSample> = {};

  constructor(private readonly deps: SubagentRoutingSyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** İlk eşitleme + ayar açıkken periyodik yenileme. */
  async start(): Promise<void> {
    await this.refresh();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ayar değiştiğinde ya da periyodik olarak çağrılır; sıralı çalışır. */
  refresh(): Promise<void> {
    const run = this.chain.then(() => this.sync());
    this.chain = run.catch(() => undefined);
    return run;
  }

  async preview(refresh = false): Promise<RoutingPreview> {
    if (refresh) await this.refresh();
    const settings = await this.deps.settings();
    const policy = toRoutingPolicy(settings);
    const headroom = settings.enabled ? this.lastHeadroom : await this.readHeadroom(policy);
    const now = this.now();
    const annotation = this.deps.router.annotateSubagentModels({
      parent: {},
      policy,
      headroom,
      now,
    });
    const rows: RoutingPreviewRow[] = [];
    for (const tier of policy.tiers) {
      const recommended = annotation.recommended[tier.id];
      for (const candidate of tier.candidates) {
        const state = this.deps.router.classifyHeadroom(
          headroom[candidate.provider],
          policy.thresholdPercent,
          now
        );
        rows.push({
          tierId: tier.id,
          tierLabel: tier.label,
          tierEnabled: tier.enabled,
          provider: candidate.provider,
          model: candidate.model,
          effort: candidate.effort ?? null,
          enabled: candidate.enabled,
          state: state.state,
          remainingPercent: state.remainingPercent,
          windowLabel: state.windowLabel,
          resetsAt: state.resetsAt,
          recommended: Boolean(
            recommended &&
            recommended.provider === candidate.provider &&
            recommended.model === candidate.model
          ),
          scarce: this.deps.router.isScarceModel(candidate.model, policy.scarceModels),
        });
      }
    }
    return {
      enabled: settings.enabled,
      rows,
      snapshotFile: this.deps.snapshotFile,
      writtenAt: settings.enabled ? this.writtenAt : null,
      lastError: this.lastError,
    };
  }

  private async sync(): Promise<void> {
    const settings = await this.deps.settings();
    if (!settings.enabled) {
      this.dispose();
      this.writtenAt = null;
      await rm(this.deps.snapshotFile, { force: true }).catch((error: unknown) => {
        this.lastError = String(error);
      });
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh().catch(() => undefined);
      }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref?.();
    }
    const policy = toRoutingPolicy(settings);
    try {
      const headroom = await this.readHeadroom(policy);
      const snapshot: SubagentRoutingSnapshot = {
        version: 1,
        enabled: true,
        writtenAt: this.now(),
        policy,
        headroom,
      };
      await writeAtomically(this.deps.snapshotFile, JSON.stringify(snapshot));
      this.lastHeadroom = headroom;
      this.writtenAt = snapshot.writtenAt;
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error);
      this.deps.logger.warn('Sub-agent routing snapshot was not written', {
        error: String(error),
      });
    }
  }

  private async readHeadroom(
    policy: SubagentRoutingPolicy
  ): Promise<Record<string, ProviderHeadroomSample>> {
    const tracked = new Set<string>(INDICATOR_USAGE_PROVIDERS);
    const providers = [
      ...new Set(
        policy.tiers.flatMap((tier) => tier.candidates.map((candidate) => candidate.provider))
      ),
    ].filter((provider) => tracked.has(provider));
    if (providers.length === 0) return {};
    const usage = await this.deps.usage.peek(
      LOCAL_HOST_REF,
      providers,
      this.deps.usageWaitMs ?? 5_000
    );
    const now = this.now();
    const headroom: Record<string, ProviderHeadroomSample> = {};
    for (const provider of providers) {
      const sample = headroomSampleFromUsage(usage[provider] ?? null, now);
      if (sample) headroom[provider] = sample;
    }
    return headroom;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
