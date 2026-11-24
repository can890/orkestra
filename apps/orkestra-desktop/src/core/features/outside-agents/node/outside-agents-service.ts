import { err, ok, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import type { Controller } from '@orkestra/wire/rpc';
import type {
  CreatedOutsideAgentClient,
  OutsideAgentAccess,
  OutsideAgentsError,
  OutsideAgentsStatus,
} from '@core/features/outside-agents/api/contract';
import {
  buildOutsideAgentSetup,
  outsideAgentsMcpUrl,
} from '@core/features/outside-agents/api/setup-snippets';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { OutsideAgentClientRegistry, type OutsideAgentsPersistence } from './client-registry';
import { createControllersBackend } from './controllers-backend';
import {
  startOutsideAgentsMcpServer,
  type OutsideAgentsMcpServer,
  type OutsideAgentsMcpServerOptions,
} from './mcp-http-server';
import type { OutsideAgentBackend } from './outside-agent-backend';

export type OutsideAgentsServiceDeps = {
  persistence: OutsideAgentsPersistence;
  secrets: SecretStore;
  logger: Logger;
  isSecureStorageAvailable: () => boolean;
  serverVersion: string;
  /** Testler için: denetleyiciler yerine sahte arka uç. */
  createBackend?: (controllers: Record<string, Controller>) => OutsideAgentBackend;
  /** Testler için: geçici port (0) ve hızlı bekleme. */
  serverOverrides?: Partial<Pick<OutsideAgentsMcpServerOptions, 'sleep' | 'now'>> & {
    port?: number;
  };
  now?: () => number;
};

/**
 * Dış ajanlar için yerel MCP sunucusunun yaşam döngüsü. VARSAYILAN KAPALI: kullanıcı ayardan
 * açmadan port dinlenmez. İstemci belirteçleri `OutsideAgentClientRegistry` ile yönetilir.
 */
export class OutsideAgentsService {
  private readonly registry: OutsideAgentClientRegistry;
  private backend: OutsideAgentBackend | null = null;
  private server: OutsideAgentsMcpServer | null = null;
  private listenError: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: OutsideAgentsServiceDeps) {
    this.registry = new OutsideAgentClientRegistry({
      persistence: deps.persistence,
      secrets: deps.secrets,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Açılıştan sonra çağrılır (denetleyiciler hazır). Ayar açıksa dinlemeye başlar. */
  async start(controllers: Record<string, Controller>): Promise<void> {
    this.backend = (this.deps.createBackend ?? createControllersBackend)(controllers);
    await this.exclusive(async () => {
      const settings = await this.registry.getSettings();
      if (settings.enabled) await this.listen(settings.port);
    });
  }

  async getStatus(): Promise<OutsideAgentsStatus> {
    const settings = await this.registry.getSettings();
    return {
      enabled: settings.enabled,
      port: this.server?.port ?? settings.port,
      listening: this.server !== null,
      url: this.server ? this.server.url : null,
      listenError: this.listenError,
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      clients: await this.registry.listClients(),
    };
  }

  configure(patch: {
    enabled?: boolean;
    port?: number;
  }): Promise<Result<OutsideAgentsStatus, OutsideAgentsError>> {
    return this.exclusive(async () => {
      if (patch.enabled && !this.deps.isSecureStorageAvailable()) {
        return err({
          type: 'storage_unavailable' as const,
          message:
            'Secure storage is not available on this system, so tokens cannot be kept safely.',
        });
      }
      const before = await this.registry.getSettings();
      const next = await this.registry.updateSettings(patch);
      const portChanged = next.port !== before.port;
      if (!next.enabled) {
        await this.stopListening();
        this.listenError = null;
      } else if (!this.server || portChanged) {
        await this.stopListening();
        await this.listen(next.port);
      }
      return ok(await this.getStatus());
    });
  }

  async createClient(
    name: string,
    access: OutsideAgentAccess
  ): Promise<Result<CreatedOutsideAgentClient, OutsideAgentsError>> {
    if (!this.deps.isSecureStorageAvailable()) {
      return err({
        type: 'storage_unavailable',
        message: 'Secure storage is not available on this system, so tokens cannot be kept safely.',
      });
    }
    const created = await this.registry.createClient(name, access);
    if (!created.success) return created;
    const settings = await this.registry.getSettings();
    const url = outsideAgentsMcpUrl(this.server?.port ?? settings.port);
    return ok({
      client: created.data.client,
      token: created.data.token,
      url,
      setup: buildOutsideAgentSetup(url, created.data.token),
    });
  }

  async setClientAccess(
    id: string,
    access: OutsideAgentAccess
  ): Promise<Result<OutsideAgentsStatus, OutsideAgentsError>> {
    const updated = await this.registry.setClientAccess(id, access);
    if (!updated.success) return updated;
    return ok(await this.getStatus());
  }

  async revokeClient(id: string): Promise<Result<OutsideAgentsStatus, OutsideAgentsError>> {
    const revoked = await this.registry.revokeClient(id);
    if (!revoked.success) return revoked;
    this.server?.closeClientSessions(id);
    return ok(await this.getStatus());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.exclusive(() => this.stopListening());
  }

  private async listen(port: number): Promise<void> {
    if (this.disposed) return;
    try {
      this.server = await startOutsideAgentsMcpServer({
        port: this.deps.serverOverrides?.port ?? port,
        authenticate: (token) => this.registry.authenticate(token),
        currentAccess: (clientId) => this.registry.currentAccess(clientId),
        backend: () => this.backend,
        onUsed: (clientId) => this.registry.touch(clientId),
        logger: this.deps.logger,
        serverVersion: this.deps.serverVersion,
        ...(this.deps.serverOverrides?.sleep ? { sleep: this.deps.serverOverrides.sleep } : {}),
        ...(this.deps.serverOverrides?.now ? { now: this.deps.serverOverrides.now } : {}),
      });
      this.listenError = null;
    } catch (error) {
      this.server = null;
      const code = (error as { code?: unknown }).code;
      this.listenError =
        code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Choose another port.`
          : error instanceof Error
            ? error.message
            : String(error);
      this.deps.logger.warn('Outside agents MCP server could not start', {
        reason: this.listenError,
      });
    }
  }

  private async stopListening(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await server.close();
  }
}
