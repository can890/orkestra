import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { quoteArg } from '@orkestra/core/primitives/exec/api';
import type { Logger } from '@orkestra/shared/logger';
import type { Client } from 'ssh2';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { workspaceServerLayout } from '@core/services/hosts/node/workspace-server/layout';
import { ORCHESTRA_BRIDGE_SOURCE, orchestraBridgeFileName } from './orchestra-mcp-bridge';

/** Uzak makinedeki şef köprüsünün nasıl başlatılacağı. */
export type OrchestraRemoteEndpoint = {
  nodePath: string;
  scriptPath: string;
  socketPath: string;
};

type ActiveForward = {
  client: Client;
  endpoint: OrchestraRemoteEndpoint;
  dispose(): void;
};

/**
 * Uzak (SSH) makinedeki şef ajanın masaüstündeki Orkestra RPC sunucusuna ulaşması için
 * OpenSSH ters Unix soketi yönlendirmesi kurar. Soket yolu bu uygulama oturumu boyunca sabittir;
 * SSH yeniden bağlandığında yönlendirme aynı yola yeniden kurulur, böylece çalışan köprüler
 * bağlantıyı kaybetmez. Köprü, workspace-server ile gelen Node çalışma zamanıyla çalışır.
 */
export class OrchestraRemoteEndpoints {
  private readonly instanceId = randomBytes(6).toString('hex');
  private readonly forwards = new Map<string, ActiveForward>();
  private readonly pending = new Map<string, Promise<OrchestraRemoteEndpoint>>();

  constructor(
    private readonly deps: {
      getProxy(connectionId: string): SshClientProxy | undefined;
      localRpcPort(): Promise<number>;
      logger: Logger;
    }
  ) {}

  /** Yönlendirmeyi gerekiyorsa kurar; bağlantı değiştiyse yeniden kurar. */
  async ensure(connectionId: string): Promise<OrchestraRemoteEndpoint> {
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
    for (const forward of this.forwards.values()) forward.dispose();
    this.forwards.clear();
  }

  private async establish(
    connectionId: string,
    proxy: SshClientProxy
  ): Promise<OrchestraRemoteEndpoint> {
    const homeResult = await proxy.execScript('printf %s "$HOME"', { timeoutMs: 15_000 });
    const home = homeResult.stdout.trim();
    if (homeResult.exitCode !== 0 || !home.startsWith('/')) {
      throw new Error('Uzak makinede ev dizini bulunamadı.');
    }
    const layout = workspaceServerLayout(home);
    const directory = path.posix.join(home, '.orkestra/orchestra');
    const endpoint: OrchestraRemoteEndpoint = {
      nodePath: path.posix.join(layout.currentLink, 'node'),
      scriptPath: path.posix.join(directory, orchestraBridgeFileName()),
      socketPath: path.posix.join(directory, `rpc-${this.instanceId}.sock`),
    };
    // Yollar yalnızca doğrulanmış ev dizininden ve sabit adlardan oluşur; betik içeriği base64
    // olarak taşındığı için kabuk tırnaklamasına girmez.
    const encoded = Buffer.from(ORCHESTRA_BRIDGE_SOURCE, 'utf8').toString('base64');
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
    const onConnection = (
      info: { socketPath: string },
      accept: () => NodeJS.ReadWriteStream & { destroy(): void },
      reject: () => void
    ) => {
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
      void reject;
    };
    await new Promise<void>((resolve, reject) => {
      client.openssh_forwardInStreamLocal(endpoint.socketPath, (error) => {
        if (error) reject(new Error(`SSH ters tüneli kurulamadı: ${error.message}`));
        else resolve();
      });
    });
    client.on('unix connection', onConnection as never);

    this.forwards.get(connectionId)?.dispose();
    this.forwards.set(connectionId, {
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
    });
    this.deps.logger.info('Orkestra: uzak tünel kuruldu', { connectionId });
    return endpoint;
  }
}

function shellQuote(value: string): string {
  return quoteArg(value, 'posix');
}
