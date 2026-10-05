import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { quoteArg } from '@orkestra/core/primitives/exec/api';
import type { Logger } from '@orkestra/shared/logger';
import type { Client } from 'ssh2';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { AGENT_TOOLS_BRIDGE_SOURCE, agentToolsBridgeFileName } from './agent-tools-bridge';

/** Uzak makinedeki köprünün nasıl başlatılacağı. */
export type AgentToolsRemoteEndpoint = {
  nodePath: string;
  scriptPath: string;
  socketPath: string;
};

export type AgentToolsRemoteEndpointsDeps = {
  getProxy(connectionId: string): SshClientProxy | undefined;
  localRpcPort(): Promise<number>;
  /** Uzak ev dizinine göre köprüyü çalıştıracak Node yolu (workspace-server çalışma zamanı). */
  nodePath(home: string): string;
  /** Köprü ve soketin tutulduğu, ev dizinine göre göreli dizin. */
  directory: string;
  logger: Logger;
  /** SSH yeniden bağlanmalarının denetlenme aralığı (ms). */
  refreshIntervalMs?: number;
};

type ActiveForward = {
  client: Client;
  endpoint: AgentToolsRemoteEndpoint;
  dispose(): void;
};

type UnixConnectionAccept = () => NodeJS.ReadWriteStream & { destroy(): void };

const DEFAULT_REFRESH_INTERVAL_MS = 2_500;

/**
 * Uzak (SSH) makinelerdeki ajan köprülerinin masaüstündeki RPC sunucusuna ulaşması için her SSH
 * bağlantısına tek bir OpenSSH ters Unix soketi yönlendirmesi kurar ve köprü betiğini bir kez
 * yükler; bağlantıyı kullanan tüm araç sunucuları (şef, tarayıcı) bunu paylaşır. Soket yolu bu
 * uygulama oturumu boyunca sabittir; SSH yeniden bağlandığında yönlendirme aynı yola yeniden
 * kurulur, böylece çalışan köprüler bağlantıyı kaybetmez.
 */
export class AgentToolsRemoteEndpoints {
  private readonly instanceId = randomBytes(6).toString('hex');
  private readonly forwards = new Map<string, ActiveForward>();
  private readonly pending = new Map<string, Promise<AgentToolsRemoteEndpoint>>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: AgentToolsRemoteEndpointsDeps) {}

  /** Yönlendirmeyi gerekiyorsa kurar; bağlantı değiştiyse yeniden kurar. */
  async ensure(connectionId: string): Promise<AgentToolsRemoteEndpoint> {
    if (this.disposed) throw new Error('Orkestra agent tools are shutting down.');
    const proxy = this.deps.getProxy(connectionId);
    if (!proxy?.isConnected) throw new Error('Uzak makineye SSH bağlantısı yok.');
    const current = this.forwards.get(connectionId);
    if (current && current.client === proxy.client) return current.endpoint;
    const inflight = this.pending.get(connectionId);
    if (inflight) return inflight;
    const task = this.establish(connectionId, proxy).finally(() => {
      this.pending.delete(connectionId);
    });
    this.pending.set(connectionId, task);
    return task;
  }

  /** Daha önce kurulmuş yönlendirmeleri, SSH yeniden bağlandıysa tazeler. */
  async refresh(): Promise<void> {
    for (const [connectionId, forward] of this.forwards) {
      const proxy = this.deps.getProxy(connectionId);
      if (!proxy?.isConnected || proxy.client === forward.client) continue;
      await this.ensure(connectionId).catch((error: unknown) => {
        this.deps.logger.warn('Orkestra: uzak tünel yenilenemedi', {
          connectionId,
          error: String(error),
        });
      });
    }
  }

  activeCount(): number {
    return this.forwards.size;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const forward of this.forwards.values()) forward.dispose();
    this.forwards.clear();
  }

  private async establish(
    connectionId: string,
    proxy: SshClientProxy
  ): Promise<AgentToolsRemoteEndpoint> {
    const homeResult = await proxy.execScript('printf %s "$HOME"', { timeoutMs: 15_000 });
    const home = homeResult.stdout.trim();
    if (homeResult.exitCode !== 0 || !home.startsWith('/') || home.includes('\0')) {
      throw new Error('Uzak makinede ev dizini bulunamadı.');
    }
    const directory = path.posix.join(home, this.deps.directory);
    const endpoint: AgentToolsRemoteEndpoint = {
      nodePath: this.deps.nodePath(home),
      scriptPath: path.posix.join(directory, agentToolsBridgeFileName()),
      socketPath: path.posix.join(directory, `rpc-${this.instanceId}.sock`),
    };
    // Yollar yalnızca doğrulanmış ev dizininden ve sabit adlardan oluşur; betik içeriği base64
    // olarak taşındığı için kabuk tırnaklamasına girmez.
    const encoded = Buffer.from(AGENT_TOOLS_BRIDGE_SOURCE, 'utf8').toString('base64');
    const prepare = await proxy.execScript(
      [
        'set -eu',
        `dir=${shellQuote(directory)}`,
        `script=${shellQuote(endpoint.scriptPath)}`,
        `socket=${shellQuote(endpoint.socketPath)}`,
        `node=${shellQuote(endpoint.nodePath)}`,
        'if [ ! -x "$node" ]; then echo "workspace-server Node çalışma zamanı bulunamadı" >&2; exit 3; fi',
        'mkdir -p "$dir"',
        'chmod 700 "$dir"',
        'if [ ! -f "$script" ]; then',
        `  printf %s ${shellQuote(encoded)} | base64 -d > "$script.tmp"`,
        '  chmod 600 "$script.tmp"',
        '  mv "$script.tmp" "$script"',
        'fi',
        'rm -f "$socket"',
      ].join('\n'),
      { timeoutMs: 20_000 }
    );
    if (prepare.exitCode !== 0) {
      throw new Error(`Uzak Orkestra köprüsü hazırlanamadı: ${prepare.stderr.trim()}`);
    }

    const client = proxy.client;
    const localPort = await this.deps.localRpcPort();
    const onConnection = (info: { socketPath: string }, accept: UnixConnectionAccept) => {
      if (info.socketPath !== endpoint.socketPath) return;
      const channel = accept();
      const local = net.connect(localPort, '127.0.0.1');
      channel.pipe(local).pipe(channel);
      const close = () => {
        local.destroy();
        channel.destroy();
      };
      local.on('error', close);
      channel.on('error', close);
      channel.on('close', () => local.destroy());
      local.on('close', () => channel.destroy());
    };
    await new Promise<void>((resolve, reject) => {
      client.openssh_forwardInStreamLocal(endpoint.socketPath, (error) => {
        if (error) reject(new Error(`SSH ters tüneli kurulamadı: ${error.message}`));
        else resolve();
      });
    });
    client.on('unix connection', onConnection as never);
    const forward: ActiveForward = {
      client,
      endpoint,
      dispose: () => {
        client.off('unix connection', onConnection as never);
        try {
          client.openssh_unforwardInStreamLocal(endpoint.socketPath, () => {});
        } catch {
          // Bağlantı zaten kapanmış olabilir.
        }
      },
    };
    if (this.disposed) {
      forward.dispose();
      throw new Error('Orkestra agent tools are shutting down.');
    }

    this.forwards.get(connectionId)?.dispose();
    this.forwards.set(connectionId, forward);
    this.startRefreshTimer();
    this.deps.logger.info('Orkestra: uzak tünel kuruldu', { connectionId });
    return endpoint;
  }

  // SSH yeniden bağlandığında (proxy yeni bir istemciye geçtiğinde) tüneli aynı sokete kurar.
  private startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.refreshing) return;
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }, this.deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }
}

function shellQuote(value: string): string {
  return quoteArg(value, 'posix');
}
