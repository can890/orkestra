import { sshConnectionIdOf, type HostRef } from '@orkestra/core/primitives/host/api';
import type { Logger } from '@orkestra/shared/logger';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import type { AgentToolsMcpServer } from '@core/services/agent-tools/api/agent-tools';
import { ensureAgentToolsBridgeScript, type AgentToolsBridgeEnvNames } from './agent-tools-bridge';
import { AgentToolsRemoteEndpoints } from './agent-tools-remote-endpoints';
import { startAgentToolsRpcServer, type AgentToolsRpcServer } from './agent-tools-rpc-server';

/** Paylaşılan RPC sunucusuna bağlanan bir araç sunucusu (ör. şef araçları, tarayıcı). */
export type AgentToolServer = {
  /** Köprünün `ORKESTRA_TOOLS_SERVER` ile bildirdiği kimlik. */
  id: string;
  /** Belirteci bu sunucunun bir konuşmasına çözer; tanımıyorsa null. */
  authenticate(token: string): string | null;
  /** `describe` ve `call` isteklerini yanıtlar. */
  handle(conversationId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
};

export type AgentToolsBridgeServerInput = {
  /** ACP oturumundaki MCP sunucu adı. */
  name: string;
  host: HostRef;
  token: string;
  env: AgentToolsBridgeEnvNames;
  /** `env.server` adıyla köprüye verilecek araç sunucusu kimliği. */
  serverId?: string;
};

/** Araç sunucularının paylaşılan köprü altyapısından kullandığı yüzey. */
export interface AgentToolsBridgeHost {
  register(server: AgentToolServer): () => void;
  /**
   * Konuşmanın ACP oturumuna eklenecek köprü tanımı. Uzak makineler için SSH ters tüneli kurar;
   * uzak destek yoksa null döner.
   */
  bridgeServer(input: AgentToolsBridgeServerInput): Promise<AgentToolsMcpServer | null>;
}

export type AgentToolsHostOptions = {
  /** Yerel köprü betiğinin yazılacağı dizin. */
  localDirectory: string;
  /** Yerel köprüyü çalıştıran ikili; Electron `ELECTRON_RUN_AS_NODE=1` ile Node gibi çalışır. */
  nodeExecutable: string;
  logger: Logger;
  /** Uzak (SSH) makineler; verilmezse yalnızca yerel konuşmalar desteklenir. */
  remote?: {
    getProxy(connectionId: string): SshClientProxy | undefined;
    nodePath(home: string): string;
    /** Ev dizinine göre göreli köprü dizini (varsayılan `.orkestra/agent-tools`). */
    directory?: string;
    refreshIntervalMs?: number;
  };
};

type Binding = { server: AgentToolServer; conversationId: string };

const DEFAULT_REMOTE_DIRECTORY = '.orkestra/agent-tools';

/**
 * Orkestra'nın ajanlara sunduğu MCP araç sunucularının ortak altyapısı: tek bir loopback RPC
 * sunucusu, tek bir köprü betiği ve her SSH bağlantısı için tek bir ters tünel. Araç sunucuları
 * kendi belirteçlerini üretir; istekler belirtece (ve köprünün bildirdiği sunucu kimliğine) göre
 * yönlendirilir, böylece bir sunucunun belirteci diğerinin araçlarını çağıramaz.
 */
export class AgentToolsHost implements AgentToolsBridgeHost {
  private readonly servers = new Map<string, AgentToolServer>();
  private server: Promise<AgentToolsRpcServer> | null = null;
  private readonly remote: AgentToolsRemoteEndpoints | null;
  private disposed = false;

  constructor(private readonly options: AgentToolsHostOptions) {
    const remote = options.remote;
    this.remote = remote
      ? new AgentToolsRemoteEndpoints({
          getProxy: remote.getProxy,
          nodePath: remote.nodePath,
          directory: remote.directory ?? DEFAULT_REMOTE_DIRECTORY,
          localRpcPort: async () => (await this.ensureServer()).port,
          logger: options.logger,
          ...(remote.refreshIntervalMs !== undefined
            ? { refreshIntervalMs: remote.refreshIntervalMs }
            : {}),
        })
      : null;
  }

  register(server: AgentToolServer): () => void {
    if (this.servers.has(server.id)) {
      throw new Error(`Agent tool server '${server.id}' is already registered`);
    }
    this.servers.set(server.id, server);
    return () => {
      if (this.servers.get(server.id) === server) this.servers.delete(server.id);
    };
  }

  async bridgeServer(input: AgentToolsBridgeServerInput): Promise<AgentToolsMcpServer | null> {
    const serverEnv =
      input.env.server && input.serverId ? { [input.env.server]: input.serverId } : {};
    const connectionId = sshConnectionIdOf(input.host);
    if (connectionId) {
      if (!this.remote) return null;
      // Uzak köprü, SSH ters tüneliyle bu makinedeki RPC sunucusuna bağlanır.
      const endpoint = await this.remote.ensure(connectionId);
      return {
        name: input.name,
        command: endpoint.nodePath,
        args: [endpoint.scriptPath],
        env: {
          [input.env.socket]: endpoint.socketPath,
          [input.env.token]: input.token,
          ...serverEnv,
        },
      };
    }
    const [server, script] = await Promise.all([
      this.ensureServer(),
      ensureAgentToolsBridgeScript(this.options.localDirectory),
    ]);
    return {
      name: input.name,
      command: this.options.nodeExecutable,
      args: [script],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        [input.env.url]: server.url,
        [input.env.token]: input.token,
        ...serverEnv,
      },
    };
  }

  /** Yerel RPC uç noktası; gerekirse sunucuyu başlatır. */
  async rpcUrl(): Promise<string> {
    return (await this.ensureServer()).url;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.remote?.dispose();
    const server = this.server;
    this.server = null;
    if (server) {
      await server.then(
        (started) => started.close(),
        () => undefined
      );
    }
  }

  private ensureServer(): Promise<AgentToolsRpcServer> {
    if (this.disposed) return Promise.reject(new Error('Orkestra agent tools are shutting down.'));
    if (!this.server) {
      const starting = startAgentToolsRpcServer<Binding>({
        authenticate: (token, claimedServer) => this.authenticate(token, claimedServer),
        handle: (binding, method, params) =>
          binding.server.handle(binding.conversationId, method, params),
        logger: this.options.logger,
      });
      this.server = starting;
      // Başlatılamayan sunucu kalıcı olarak önbellekte kalmasın; sonraki çağrı yeniden dener.
      starting.catch(() => {
        if (this.server === starting) this.server = null;
      });
    }
    return this.server;
  }

  private authenticate(token: string, claimedServer: string | null): Binding | null {
    if (claimedServer !== null) {
      const server = this.servers.get(claimedServer);
      const conversationId = server?.authenticate(token) ?? null;
      return server && conversationId ? { server, conversationId } : null;
    }
    for (const server of this.servers.values()) {
      const conversationId = server.authenticate(token);
      if (conversationId) return { server, conversationId };
    }
    return null;
  }
}
