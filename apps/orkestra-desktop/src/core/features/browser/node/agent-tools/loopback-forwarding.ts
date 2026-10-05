import { sshConnectionIdOf, type HostRef } from '@orkestra/core/primitives/host/api';
import type { Result } from '@orkestra/shared';
import { normalizeBrowserUrl, type BrowserUrlRejectionReason } from '@core/primitives/browser/api';
import type {
  ForwardedPreviewServer,
  ManualPreviewServerRequest,
  ManualPreviewServerResult,
  PreviewServer,
  PreviewServerProtocol,
  PreviewServerUnavailableError,
} from '@core/primitives/preview-servers/api';

/** Bir konuşmanın tarayıcı araçlarının kapsamı: görevin kimliği ve çalıştığı makine. */
export type BrowserToolScope = Readonly<{
  conversationId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  host: HostRef;
}>;

/**
 * Uzak port yönlendirmesi için kullanılan mevcut önizleme sunucusu işlemleri
 * (`PreviewServerAccessService`); proje bağlılığı denetimi orada yapılır.
 */
export type LoopbackForwardBackend = {
  listForWorkspace(input: {
    projectId: string;
    workspaceId: string;
  }): Promise<Result<PreviewServer[], PreviewServerUnavailableError>>;
  forwardManual(input: ManualPreviewServerRequest): Promise<ManualPreviewServerResult>;
};

export type ResolvedBrowserUrl = {
  /** Tarayıcının açacağı adres. */
  url: string;
  /** Uzak makinenin loopback adresi SSH ile yönlendirildiyse eşleme. */
  forward?: { remotePort: number; localPort: number };
};

type ActiveForward = ForwardedPreviewServer & { localPort: number };

/** Uzak makinede çalışan bir sunucuyu gösteren loopback adları (URL.hostname biçiminde). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

const REJECTION_TEXT: Record<BrowserUrlRejectionReason, string> = {
  empty: 'the URL is empty',
  'invalid-url': 'it is not a valid URL',
  'unsupported-protocol': 'only http and https URLs can be opened',
  'unsupported-file-url': 'file URLs cannot be opened',
};

/**
 * Ajanın verdiği adresleri tarayıcının açacağı adreslere çevirir. Yerel konuşmalarda adres
 * değişmez. Uzak (SSH) konuşmalarda localhost/127.0.0.1/0.0.0.0/[::1] uzak makineyi kasteder:
 * port mevcut önizleme yönlendirmesiyle (gerekirse yenisi açılarak) masaüstüne taşınır ve
 * adres http(s)://127.0.0.1:<yerel port> biçimine çevrilir.
 */
export class LoopbackForwarder {
  private readonly inflight = new Map<string, Promise<ActiveForward>>();

  constructor(private readonly backend: LoopbackForwardBackend) {}

  async resolve(raw: string, scope: BrowserToolScope): Promise<ResolvedBrowserUrl> {
    // Şemasız 0.0.0.0 da diğer loopback adları gibi http kabul edilir.
    const candidate = /^0\.0\.0\.0(?=[:/?#]|$)/.test(raw) ? `http://${raw}` : raw;
    const normalized = normalizeBrowserUrl(candidate, { allowSearchQueries: false });
    if (!normalized.ok) {
      throw new Error(
        `Cannot open "${raw}": ${REJECTION_TEXT[normalized.reason]}. Pass a full URL such as https://example.com or http://localhost:3000.`
      );
    }
    const connectionId = sshConnectionIdOf(scope.host);
    if (!connectionId) return { url: normalized.url };
    const url = new URL(normalized.url);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !LOOPBACK_HOSTS.has(url.hostname)
    ) {
      return { url: normalized.url };
    }
    const protocol: PreviewServerProtocol = url.protocol === 'https:' ? 'https:' : 'http:';
    const port = url.port ? Number(url.port) : protocol === 'https:' ? 443 : 80;
    const forwards = await this.forwardsOf(scope, connectionId);
    // Daha önce verilen yerel adres (127.0.0.1:<yerel port>) yeniden yönlendirilmez.
    if (url.hostname === '127.0.0.1') {
      const own = forwards.find((server) => server.localPort === port);
      if (own) {
        return { url: normalized.url, forward: { remotePort: own.remotePort, localPort: port } };
      }
    }
    const server =
      forwards.find((candidate) => candidate.remotePort === port && isUsable(candidate)) ??
      (await this.open(scope, connectionId, protocol, port));
    url.hostname = '127.0.0.1';
    url.port = String(server.localPort);
    return { url: url.toString(), forward: { remotePort: port, localPort: server.localPort } };
  }

  /** Yönlendirilmiş yerel adresi ajana uzak makinedeki karşılığıyla gösterir. */
  async describe(url: string, scope: BrowserToolScope): Promise<string> {
    const connectionId = sshConnectionIdOf(scope.host);
    if (!connectionId) return url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    if (parsed.hostname !== '127.0.0.1' || !parsed.port) return url;
    const port = Number(parsed.port);
    const server = (await this.forwardsOf(scope, connectionId)).find(
      (candidate) => candidate.localPort === port
    );
    return server ? `${url} (remote localhost:${server.remotePort})` : url;
  }

  private async forwardsOf(
    scope: BrowserToolScope,
    connectionId: string
  ): Promise<ActiveForward[]> {
    const listed = await this.backend.listForWorkspace({
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
    });
    if (!listed.success) return [];
    return listed.data.filter(
      (server): server is ActiveForward =>
        server.kind === 'forwarded' &&
        server.connectionId === connectionId &&
        server.localPort !== undefined
    );
  }

  private open(
    scope: BrowserToolScope,
    connectionId: string,
    protocol: PreviewServerProtocol,
    remotePort: number
  ): Promise<ActiveForward> {
    const key = [connectionId, scope.projectId, scope.workspaceId, remotePort].join('\0');
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.forward(scope, connectionId, protocol, remotePort).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async forward(
    scope: BrowserToolScope,
    connectionId: string,
    protocol: PreviewServerProtocol,
    remotePort: number
  ): Promise<ActiveForward> {
    const result = await this.backend.forwardManual({
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      connectionId,
      protocol,
      remotePort,
    });
    if (!result.success) {
      throw new Error(
        `Could not forward port ${remotePort} of the workspace host over SSH: ${result.error.message}`
      );
    }
    const server = result.data;
    if (server.kind !== 'forwarded' || server.localPort === undefined) {
      throw new Error(`Could not forward port ${remotePort} of the workspace host over SSH.`);
    }
    return { ...server, localPort: server.localPort };
  }
}

function isUsable(server: ActiveForward): boolean {
  return server.status.kind !== 'failed';
}
