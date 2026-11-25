import { join } from 'node:path';
import { acpApiContract } from '@orkestra/core/runtimes/acp/api';
import { agentConfigContract } from '@orkestra/core/runtimes/agent-config/api';
import { automationsContract } from '@orkestra/core/runtimes/automations/api';
import { conversationsContract } from '@orkestra/core/runtimes/conversations/api';
import { fileSearchContract } from '@orkestra/core/runtimes/file-search/api';
import { filesContract } from '@orkestra/core/runtimes/files/api';
import { gitContract } from '@orkestra/core/runtimes/git/api';
import { hostSettingsContract } from '@orkestra/core/runtimes/host-settings/api';
import { resourceUsageContract } from '@orkestra/core/runtimes/resource-usage/api';
import { scriptsContract } from '@orkestra/core/runtimes/scripts/api';
import { terminalsContract } from '@orkestra/core/runtimes/terminals/api';
import { tuiAgentsContract } from '@orkestra/core/runtimes/tui-agents/api';
import { workspaceRegistryContract } from '@orkestra/core/runtimes/workspace-registry/api';
import { hostDependenciesContract } from '@orkestra/core/services/host-dependencies/api';
import type { Scope } from '@orkestra/shared/concurrency';
import { systemClock } from '@orkestra/shared/scheduling';
import { queuedClient } from '@orkestra/wire/rpc';
import {
  createWireWorkerHost,
  pooledProcessSpawner,
  WORKER_NAME_ENV_VAR,
  type WireWorkerState,
} from '@orkestra/wire/worker';
import { childProcessSpawner } from '@orkestra/wire/worker/node';
import { app } from 'electron';
import { createGitHubCredentialReader } from '@core/features/github/api/node/services/github-credentials';
import { getIntegrationAccountStore } from '@core/features/integrations/node/integration-account-store-instance';
import { mementoSweepPolicies } from '@core/manifests/shared/memento-catalog';
import { mementosWireContract } from '@core/primitives/mementos/api';
import { HostRuntimeConnection } from '@core/services/hosts/node/host-runtime-connection';
import { openLocalWorkspaceServerTransport } from '@core/services/hosts/node/workspace-server/connect/local-socket-transport';
import { mementosComponent } from '@core/services/mementos/node';
import { pullRequestsContract } from '@core/services/pull-requests/api';
import { pullRequestsComponent } from '@core/services/pull-requests/node';
import { createPullRequestsGitHubAuthController } from '@core/services/pull-requests/node/pull-requests-auth';
import { resolvePullRequestSyncIdentity } from '@core/services/pull-requests/node/sync-identity';
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { log } from '@main/lib/logger';
import type {
  DesktopWorkersHandle,
  StartDesktopWorkersDeps,
  WorkerStatusSource,
} from './desktop-workers';
import { desktopWorkerPath, desktopWorkerPoolHostPath } from './worker-paths';
import { desktopWorkerPoolFor } from './worker-pools';

function createSocketStatusSource(): {
  source: WorkerStatusSource;
  setState: (state: WireWorkerState) => void;
} {
  let current: WireWorkerState = { kind: 'starting', generation: 0, attempt: 1 };
  const listeners = new Set<(state: WireWorkerState) => void>();
  return {
    source: {
      onStateChanged(cb) {
        listeners.add(cb);
        cb(current);
        return () => listeners.delete(cb);
      },
    },
    setState(next) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/**
 * Headless/ortak makine modu (`SOVRA_LOCAL_WORKSPACE_SOCKET`):
 * Yerel 13 ayrı Electron runtime işçisi başlatmak yerine doğrudan makinedeki tek ortak
 * `workspace-server` Unix soketine (`~/.orkestra/workspace-server/run/workspace.sock`) bağlanır.
 *
 * Böylece:
 * 1) Mac masaüstü (SSH üzerinden) ve mobil erişim (headless üzerinden) aynı `acp-runtime` ve
 *    `conversations-runtime` tek kaynağını paylaşır — konuşmalar ve akışlar anlık eşzamanlıdır.
 * 2) Ajan süreçleri saf Node.js `workspace-server` içinde yaşar; `sovra-headless` veya mobil
 *    bağlantı kopsa/yeniden başlasa bile çalışan görevler kesintisiz devam eder.
 */
export async function startLocalWorkspaceSocketWorkers(
  deps: StartDesktopWorkersDeps,
  socketPath: string
): Promise<DesktopWorkersHandle> {
  const scope: Scope = deps.scope.child('local-workspace-socket');
  const status = createSocketStatusSource();

  let resolveFirstReady: (() => void) | undefined;
  const firstReady = new Promise<void>((resolve) => {
    resolveFirstReady = resolve;
  });

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let connecting = false;
  let disposed = false;

  const scheduleReconnect = () => {
    if (disposed || scope.disposed || reconnectTimer !== null) return;
    const delays = [500, 1_000, 2_000, 4_000, 5_000];
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectLoop();
    }, delay);
    reconnectTimer.unref?.();
  };

  const runtimeConn = new HostRuntimeConnection({
    scope,
    clock: systemClock,
    open: (target) => {
      if (target.kind !== 'local-socket') {
        return Promise.reject(new Error('Expected local-socket target'));
      }
      return openLocalWorkspaceServerTransport(target, { connectTimeoutMs: 5_000 });
    },
    openTimeoutMs: 5_000,
    initializeTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    client: { id: `sovra-local-socket-${process.pid}`, appVersion: app.getVersion() },
    onDisconnect: () => {
      if (disposed || scope.disposed) return;
      log.warn('Local workspace-server socket disconnected; scheduling reconnect', { socketPath });
      status.setState({
        kind: 'starting',
        generation: runtimeConn.generation,
        attempt: attempt + 1,
      });
      scheduleReconnect();
    },
    onRequestTimeout: () => {
      log.warn('Local workspace-server socket request timed out', { socketPath });
    },
  });

  const connectLoop = async () => {
    if (disposed || scope.disposed || connecting || runtimeConn.connected) return;
    connecting = true;
    attempt += 1;
    try {
      await runtimeConn.establish({ kind: 'local-socket', socketPath }, scope.signal);
      attempt = 0;
      status.setState({ kind: 'ready', generation: runtimeConn.generation, attempt: 1 });
      log.info('Connected to shared local workspace-server socket', {
        socketPath,
        serverVersion: runtimeConn.currentHandshake?.server.appVersion,
      });
      resolveFirstReady?.();
      resolveFirstReady = undefined;
    } catch (error) {
      if (!disposed && !scope.disposed) {
        log.warn('Failed to connect to local workspace-server socket; retrying', {
          socketPath,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleReconnect();
      }
    } finally {
      connecting = false;
    }
  };

  scope.add(() => {
    disposed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    resolveFirstReady?.();
    resolveFirstReady = undefined;
  });

  // İlk yerel soket bağlantısını doğrudan bekle (~15-30 ms); bağlantı kurulamazsa arka planda
  // yeniden denemeye devam eder ve queuedClient çağrıları ilk bağlantı kurulunca otomatik akışa geçer.
  await connectLoop();

  // Yalnızca masaüstüne özgü hafif 2 işçi (mementos, pull-requests) yerel başlatılır.
  const processSpawner = pooledProcessSpawner({
    scope,
    inner: childProcessSpawner(),
    hostEntry: desktopWorkerPoolHostPath(),
    poolFor: (spec) => desktopWorkerPoolFor(spec.env?.[WORKER_NAME_ENV_VAR]),
    logger: log,
  });
  const host = createWireWorkerHost({
    scope,
    processSpawner,
    defaults: { readyTimeoutMs: 60_000 },
    logger: log,
  });
  const mementosWorker = host.create(mementosComponent, {
    name: 'mementos',
    executable: desktopWorkerPath('mementos'),
    env: process.env,
    dependencies: {},
    config: {
      databasePath: join(app.getPath('userData'), 'mementos.db'),
      sweepPolicies: mementoSweepPolicies,
    },
  });
  const pullRequestsWorker = host.create(pullRequestsComponent, {
    name: 'pull-requests',
    executable: desktopWorkerPath('pull-requests'),
    env: process.env,
    dependencies: {
      githubAuth: createPullRequestsGitHubAuthController(
        createGitHubCredentialReader(
          {
            getAccount: (providerId, accountId) =>
              getIntegrationAccountStore().getAccount(providerId, accountId),
          },
          providerAccountRegistry
        ),
        resolvePullRequestSyncIdentity
      ),
    },
    config: {
      databasePath: join(app.getPath('userData'), 'pull-requests.db'),
      incrementalIntervalMs: 60_000,
    },
  });

  const mementosReady = mementosWorker.ready();
  const pullRequestsReady = pullRequestsWorker.ready();
  const runtimeReady = Promise.all([firstReady, mementosReady, pullRequestsReady]).then(() => {});

  const ws = runtimeConn.client;
  const whenConnected = <T>(pick: () => T) => firstReady.then(pick);
  let disposePromise: Promise<void> | undefined;
  return {
    clients: {
      acp: queuedClient(acpApiContract, () => whenConnected(() => ws.acp)),
      agentConfig: queuedClient(agentConfigContract, () => whenConnected(() => ws.agentConfig)),
      automations: queuedClient(automationsContract, () => whenConnected(() => ws.automations)),
      conversations: queuedClient(conversationsContract, () =>
        whenConnected(() => ws.conversations)
      ),
      fileSearch: queuedClient(fileSearchContract, () => whenConnected(() => ws.fileSearch)),
      files: queuedClient(filesContract, () => whenConnected(() => ws.files)),
      git: queuedClient(gitContract, () => whenConnected(() => ws.git)),
      hostDependencies: queuedClient(hostDependenciesContract, () =>
        whenConnected(() => ws.hostDependencies)
      ),
      hostSettings: queuedClient(hostSettingsContract, () => whenConnected(() => ws.hostSettings)),
      mementos: queuedClient(mementosWireContract, () => mementosReady),
      pullRequests: queuedClient(pullRequestsContract, () => pullRequestsReady),
      resourceUsage: queuedClient(resourceUsageContract, () =>
        whenConnected(() => ws.resourceUsage)
      ),
      scripts: queuedClient(scriptsContract, () => whenConnected(() => ws.scripts)),
      terminals: queuedClient(terminalsContract, () => whenConnected(() => ws.terminals)),
      tuiAgents: queuedClient(tuiAgentsContract, () => whenConnected(() => ws.tuiAgents)),
      workspaceRegistry: queuedClient(workspaceRegistryContract, () =>
        whenConnected(() => ws.workspaceRegistry)
      ),
    },
    workers: {
      acp: status.source,
      pullRequests: pullRequestsWorker,
      tuiAgents: status.source,
    },
    runtimeReady: () => runtimeReady,
    startVitalsSampling: () => {},
    setSpawnLogging: () => {},
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        await host.dispose();
        await scope.dispose();
      })();
      return disposePromise;
    },
  };
}
