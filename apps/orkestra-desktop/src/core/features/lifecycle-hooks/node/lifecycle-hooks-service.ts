import path from 'node:path';
import type { Logger } from '@orkestra/shared/logger';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import type { HookRunRecord } from '../api/hook-runs';
import { HookConfigStore, LIFECYCLE_HOOKS_FILE, type HookConfigSnapshot } from './hook-config-store';
import { attachLifecycleHookSink } from './hook-event-bus';
import { LifecycleHookDispatcher } from './hook-dispatcher';
import type { HookProcessRunner } from './hook-process-runner';

/** Masaüstü bağlama katmanının sağladığı kısım. */
export type LifecycleHooksContextHost = Readonly<{
  /** userData dizini (mutlak). */
  dataDirectory: string;
  secrets: SecretStore;
  /** Kullanıcının kabuk oturumu env'i. */
  baseEnv(): NodeJS.ProcessEnv;
}>;

export type LifecycleHooksHost = LifecycleHooksContextHost &
  Readonly<{
  isLocalProject(projectId: string): Promise<boolean>;
  resolveShellSetup(): Promise<string | undefined>;
  runner: HookProcessRunner;
  }>;

/** Yapılandırma deposu + dağıtıcıyı birleştirir ve olay yoluna bağlar. */
export class LifecycleHooksService {
  readonly store: HookConfigStore;
  readonly dispatcher: LifecycleHookDispatcher;
  private detach: (() => void) | null = null;

  constructor(
    host: LifecycleHooksHost,
    logger: Pick<Logger, 'warn' | 'info'>
  ) {
    this.store = new HookConfigStore({
      filePath: path.join(host.dataDirectory, LIFECYCLE_HOOKS_FILE),
      secrets: host.secrets,
      logger,
    });
    this.dispatcher = new LifecycleHookDispatcher({
      getConfig: () => this.store.get().config,
      runner: host.runner,
      isLocalProject: host.isLocalProject,
      resolveShellSetup: host.resolveShellSetup,
      baseEnv: host.baseEnv,
      logger,
    });
  }

  async start(): Promise<void> {
    await this.store.load();
    this.detach = attachLifecycleHookSink((event) => this.dispatcher.emit(event));
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
  }

  async save(input: unknown) {
    const result = await this.store.save(input);
    if (result.success) {
      this.dispatcher.pruneRuns(new Set(result.snapshot.config.hooks.map((hook) => hook.id)));
    }
    return result;
  }

  state(): HookConfigSnapshot {
    return this.store.get();
  }

  runs(): HookRunRecord[] {
    return this.dispatcher.getRuns();
  }

  clearRuns(): void {
    this.dispatcher.clearRuns();
  }
}
