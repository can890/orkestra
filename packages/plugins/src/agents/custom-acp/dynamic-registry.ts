// Yerleşik eklentilerin üzerine, kullanıcı ACP ajanlarını dosyadan okuyan bir kayıt katmanı.
// Her süreç (ana süreç ve worker'lar) aynı dosyayı okur; değişiklik mtime ile algılanır, böylece
// ajan eklendiğinde/kaldırıldığında süreçleri yeniden başlatmak gerekmez.
import { readFileSync, statSync } from 'node:fs';
import type { CLIAgentPluginProvider } from '@orkestra/core/services/agent-plugins/api/plugins';
import type { PluginRegistry } from '@orkestra/shared/plugins';
import { createCustomAcpProvider } from './provider';
import { parseCustomAcpAgentsFile, type CustomAcpAgent } from './schema';

export type DynamicAgentRegistryOptions = {
  builtIns: PluginRegistry<CLIAgentPluginProvider>;
  /** Kullanıcı ajanları dosyasının yolu; tanımsızsa yalnızca yerleşikler kullanılır. */
  filePath: () => string | undefined;
  /** Aynı dosyanın yeniden stat edilmesi için asgari aralık (ms). */
  recheckIntervalMs?: number;
  now?: () => number;
};

export type DynamicAgentRegistry = PluginRegistry<CLIAgentPluginProvider> & {
  /** Dosyayı hemen yeniden okur (ana süreç yazdıktan sonra çağırır). */
  reload(): void;
  customAgents(): CustomAcpAgent[];
};

type Snapshot = {
  path: string | undefined;
  stamp: string;
  agents: CustomAcpAgent[];
  providers: Map<string, CLIAgentPluginProvider>;
};

export function createDynamicAgentRegistry(
  options: DynamicAgentRegistryOptions
): DynamicAgentRegistry {
  const interval = options.recheckIntervalMs ?? 1_000;
  const now = options.now ?? Date.now;
  let snapshot: Snapshot = { path: undefined, stamp: '', agents: [], providers: new Map() };
  let checkedAt = Number.NEGATIVE_INFINITY;

  const load = (force: boolean): Snapshot => {
    const path = options.filePath();
    const time = now();
    if (!force && path === snapshot.path && time - checkedAt < interval) return snapshot;
    checkedAt = time;
    if (!path) {
      snapshot = { path, stamp: '', agents: [], providers: new Map() };
      return snapshot;
    }
    let stamp = 'missing';
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Dosya yoksa kullanıcı ajanı da yoktur.
    }
    if (!force && path === snapshot.path && stamp === snapshot.stamp) return snapshot;
    let agents: CustomAcpAgent[] = [];
    if (stamp !== 'missing') {
      try {
        agents = parseCustomAcpAgentsFile(readFileSync(path, 'utf8'));
      } catch {
        agents = [];
      }
    }
    const providers = new Map<string, CLIAgentPluginProvider>();
    for (const agent of agents) {
      // Yerleşik bir ajanla çakışan kimlik asla yerleşiği gölgeleyemez.
      if (options.builtIns.get(agent.id)) continue;
      try {
        providers.set(agent.id, createCustomAcpProvider(agent));
      } catch {
        // Geçersiz tanım tek başına atlanır.
      }
    }
    snapshot = { path, stamp, agents, providers };
    return snapshot;
  };

  return {
    register(plugin) {
      options.builtIns.register(plugin);
    },
    get(id) {
      return options.builtIns.get(id) ?? load(false).providers.get(id);
    },
    getAll() {
      return [...options.builtIns.getAll(), ...load(false).providers.values()];
    },
    ids() {
      return [...options.builtIns.ids(), ...load(false).providers.keys()];
    },
    reload() {
      load(true);
    },
    customAgents() {
      return [...load(false).agents];
    },
  };
}
