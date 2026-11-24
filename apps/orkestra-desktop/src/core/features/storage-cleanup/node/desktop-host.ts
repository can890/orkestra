import { homedir } from 'node:os';
import path from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { containsAbsolute, parseNativeAbsolute } from '@orkestra/core/primitives/path/api';
import type { HostRuntimesClient, RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import type { Scope } from '@orkestra/shared/concurrency';
import type { AppDb } from '@core/services/app-db/node/db';
import { projectSettings } from '@core/services/app-db/node/schema';
import type { AppSettingsService } from '@core/services/settings/node/app-settings-service';
import { WORKTREE_CHECKOUT_CACHE_DIRNAME } from '../api/paths';
import { CleanupScheduler } from './cleanup-scheduler';
import { StorageCleanupService } from './storage-cleanup-service';

type Logger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
};

/**
 * Bir yol altında çalışan ACP/TUI/terminal oturumu sayısı — workspace-registry'nin
 * devre dışı bırakırken kapattığı küme (askıya alınmış ACP oturumları sayılmaz).
 */
export async function countSessionsUnder(
  clients: Pick<HostRuntimesClient, 'acp' | 'terminals' | 'tuiAgents'>,
  workspacePath: string
): Promise<number> {
  const parsed = parseNativeAbsolute(workspacePath);
  if (!parsed.success) throw new Error(`Not an absolute path: ${workspacePath}`);
  const root = parsed.data;
  const under = (cwd: string | null | undefined) => {
    if (!cwd) return false;
    const target = parseNativeAbsolute(cwd);
    return target.success && containsAbsolute(root, target.data);
  };
  const [terminals, acp, tui] = await Promise.all([
    clients.terminals.sessions.state(undefined, 'list').snapshot(),
    clients.acp.sessions.state(undefined, 'list').snapshot(),
    clients.tuiAgents.sessions.state(undefined, 'list').snapshot(),
  ]);
  let count = 0;
  for (const session of Object.values(acp.data)) {
    if (!session.suspended && under(session.cwd)) count += 1;
  }
  for (const session of Object.values(tui.data)) if (under(session.cwd)) count += 1;
  for (const session of Object.values(terminals.data)) {
    if (containsAbsolute(root, session.key.workspace.path)) count += 1;
  }
  return count;
}

/** `~` ile başlayan yolları açar. */
function expandHome(target: string, home: string): string {
  if (target === '~') return home;
  if (target.startsWith('~/')) return path.join(home, target.slice(2));
  return target;
}

/** Proje geçersiz kılmalarındaki `worktreeRoot` değerleri (masaüstü proje ayarları tablosu). */
async function projectWorktreeRoots(db: AppDb): Promise<string[]> {
  const rows = await db
    .select({ json: projectSettings.baseProjectSettingsJson })
    .from(projectSettings);
  const roots: string[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.json) as { worktreeRoot?: unknown };
      if (typeof parsed.worktreeRoot === 'string' && parsed.worktreeRoot.trim()) {
        roots.push(parsed.worktreeRoot.trim());
      }
    } catch {
      // Bozuk satır: o projenin kökü yönetilen sayılmaz (temizlik o worktree'lere dokunmaz).
    }
  }
  return roots;
}

/**
 * Masaüstü ana sürecinde depolama temizliğini kurar: servis, saatlik zamanlayıcı ve
 * ayar değişikliği aboneliği. Yalnızca bu makinedeki (yerel) worktree'ler ve veri
 * klasörleri kapsanır; SSH makinelerine dokunulmaz.
 */
export function startDesktopStorageCleanup(input: {
  db: AppDb;
  appSettings: AppSettingsService;
  runtimes: RuntimeBroker;
  userDataDir: string;
  logger: Logger;
  scope: Scope;
}): StorageCleanupService {
  const home = homedir();
  const localRuntime = async () => {
    const local = await input.runtimes.client(LOCAL_HOST_REF);
    if (!local.success) throw new Error('Local runtime is unavailable');
    return local.data;
  };
  const service = new StorageCleanupService({
    db: input.db,
    getSettings: () => input.appSettings.get('storageCleanup'),
    paths: {
      logsDir: path.join(input.userDataDir, 'logs'),
      activeLogNames: ['orkestra.log'],
      cacheDirs: [
        // Mobil uzak erişimin medya önbelleği (remote-access) ve performans izleri (dev-perf).
        path.join(home, '.local', 'state', 'orkestra', 'remote-media-cache'),
        path.join(input.userDataDir, 'traces'),
      ],
      checkoutCacheDir: path.join(input.userDataDir, WORKTREE_CHECKOUT_CACHE_DIRNAME),
      attachmentsDir: path.join(input.userDataDir, 'acp-attachments'),
    },
    managedWorktreeRoots: async () => {
      const roots = [path.join(home, 'orkestra', 'worktrees')];
      try {
        const local = await localRuntime();
        const hostSettings = await local.hostSettings.get();
        const hostRoot = hostSettings.success ? hostSettings.data.settings.worktreeRoot : undefined;
        if (hostRoot?.trim()) roots.push(hostRoot.trim());
      } catch {
        // Yerel runtime yoksa yalnızca varsayılan kök ve proje kökleri kullanılır.
      }
      roots.push(...(await projectWorktreeRoots(input.db)));
      return roots.map((root) => path.resolve(expandHome(root, home)));
    },
    countSessions: async (worktreePath) => {
      const local = await localRuntime();
      return await countSessionsUnder(local, worktreePath);
    },
    refreshWorkspace: async (workspaceId) => {
      const local = await localRuntime();
      await local.workspaceRegistry.refresh({ workspaceId });
    },
    logger: input.logger,
  });

  const scheduler = new CleanupScheduler({
    run: async (trigger) => {
      await service.run(trigger);
    },
    startupDelayMs: 30_000,
    onError: (error) => input.logger.warn('storage cleanup run failed', { error: String(error) }),
  });
  const onSettingsChanged = (key: string) => {
    if (key === 'storageCleanup') scheduler.settingsChanged();
  };
  input.appSettings.on('app-settings:changed', onSettingsChanged);
  input.scope.add(() => {
    input.appSettings.off('app-settings:changed', onSettingsChanged);
    scheduler.dispose();
  });
  scheduler.start();
  return service;
}
