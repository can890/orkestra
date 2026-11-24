import { createConnectionManager, type ConnectionManager } from './connection-manager';
import { DEFAULT_DISCOVERY_URL, fetchDiscoveryEndpoint } from './discovery';
import type { PairingPayload } from './pairing';
import { recordFromPayload, type PairingRecord, type PairingRepository } from './pairing-store';
import { createRemoteApi, type RemoteApi } from './wire-client';

export type AppState =
  | { phase: 'loading' }
  | { phase: 'unpaired' }
  | {
      phase: 'paired';
      record: PairingRecord;
      hosts: PairingRecord[];
      manager: ConnectionManager;
      api: RemoteApi;
    };

export type AppSessionOptions = {
  repository: PairingRepository;
  clientName: string;
  platform: string;
  now?: () => number;
  /** Testler için: yöneticiyi değiştirir. */
  createManager?: typeof createConnectionManager;
  /** Failover öncesi kaç başarısız bağlantı turu beklensin (varsayılan 2). */
  failoverAfterRounds?: number;
};

/**
 * Uygulamanın yaşam döngüsü: kayıtlı bilgisayarları (Mac, Huawei vb.) yükler, aktif bilgisayara
 * bağlanır; aktif bilgisayar ulaşılamazsa diğer kayıtlı açık bilgisayara otomatik geçiş (failover)
 * yapar. Sır yalnızca `PairingRepository` (güvenli depo) ve yönetici içinde yaşar.
 */
export class AppSession {
  private state: AppState = { phase: 'loading' };
  private readonly listeners = new Set<() => void>();
  private initStarted = false;
  private hosts: PairingRecord[] = [];
  private consecutiveFailures = 0;

  constructor(private readonly options: AppSessionOptions) {}

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Kayıtlı eşleşme varsa bağlanır; yoksa eşleştirme ekranına düşer. */
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    try {
      const collection = await this.options.repository.loadAll();
      if (collection && collection.hosts.length > 0) {
        this.hosts = collection.hosts;
        const active =
          collection.hosts.find((h) => h.hostId === collection.activeHostId) ??
          collection.hosts[0]!;
        this.activate(active);
        return;
      }
    } catch {
      // Güvenli depo okunamadıysa kullanıcı yeniden eşleşir.
    }
    this.hosts = [];
    this.set({ phase: 'unpaired' });
  }

  /** Yeni bilgisayarı (Mac / Huawei) güvenli depoya ekler ve ona bağlanır (diğerleri korunur). */
  async pair(payload: PairingPayload): Promise<void> {
    const record = recordFromPayload(payload, (this.options.now ?? Date.now)());
    await this.options.repository.save(record);
    const collection = await this.options.repository.loadAll();
    this.hosts = collection?.hosts ?? [record];
    this.deactivate();
    this.activate(record);
  }

  /** Kayıtlı başka bir bilgisayara (örn. Mac ↔ Huawei) anında geçer. */
  async switchHost(hostId: string): Promise<void> {
    const target = this.hosts.find((h) => h.hostId === hostId);
    if (!target) return;
    if (this.state.phase === 'paired' && this.state.record.hostId === hostId) return;
    const collection = await this.options.repository.setActiveHost(hostId);
    if (collection) this.hosts = collection.hosts;
    this.deactivate();
    this.activate(target);
  }

  /** Yalnızca seçilen bilgisayarı kaldırır; başka bilgisayar varsa ona geçer. */
  async removeHost(hostId: string): Promise<void> {
    const remaining = await this.options.repository.removeHost(hostId);
    if (!remaining || remaining.hosts.length === 0) {
      this.deactivate();
      this.hosts = [];
      this.set({ phase: 'unpaired' });
      return;
    }
    this.hosts = remaining.hosts;
    const active =
      remaining.hosts.find((h) => h.hostId === remaining.activeHostId) ?? remaining.hosts[0]!;
    if (this.state.phase !== 'paired' || this.state.record.hostId !== active.hostId) {
      this.deactivate();
      this.activate(active);
    } else {
      this.set({ ...this.state, record: active, hosts: [...this.hosts] });
    }
  }

  /** Tüm eşleşmeleri kaldırır ve güvenli depoyu temizler. */
  async unpair(): Promise<void> {
    this.deactivate();
    this.hosts = [];
    await this.options.repository.clear();
    this.set({ phase: 'unpaired' });
  }

  /** Aktif veya belirtilen bilgisayara özel `wss://` tünel ya da LAN adresi ekler ve yeniden bağlanır. */
  async addAddress(hostId: string, address: string): Promise<boolean> {
    const updated = await this.options.repository.addAddress(hostId, address);
    if (!updated) return false;
    this.hosts = this.hosts.map((h) => (h.hostId === hostId ? updated : h));
    if (this.state.phase === 'paired' && this.state.record.hostId === hostId) {
      this.deactivate();
      this.activate(updated);
    }
    return true;
  }

  /** Aktif veya belirtilen bilgisayarın dinamik keşif URL'sini günceller. */
  async setDiscoveryUrl(hostId: string, discoveryUrl: string | null): Promise<boolean> {
    const updated = await this.options.repository.updateDiscoveryUrl(hostId, discoveryUrl);
    if (!updated) return false;
    this.hosts = this.hosts.map((h) => (h.hostId === hostId ? updated : h));
    if (this.state.phase === 'paired' && this.state.record.hostId === hostId) {
      this.deactivate();
      this.activate(updated);
    }
    return true;
  }

  /** Uygulama arka plandan dönünce: ölü olabilecek soketi tazeler. */
  refresh(): void {
    if (this.state.phase === 'paired') this.state.manager.refresh();
  }

  private activate(record: PairingRecord): void {
    this.consecutiveFailures = 0;
    const create = this.options.createManager ?? createConnectionManager;
    const isReal = !this.options.createManager;
    const mdns = record.hostName?.endsWith('.local') ? [record.hostName] : [];
    const discoveryUrl = record.discoveryUrl ?? (isReal ? DEFAULT_DISCOVERY_URL : undefined);
    const failoverThreshold = this.options.failoverAfterRounds ?? 2;

    const manager = create({
      record,
      clientName: this.options.clientName,
      platform: this.options.platform,
      ...(isReal ? { localCandidates: ['127.0.0.1'], fallbackCandidates: mdns } : {}),
      ...(discoveryUrl
        ? {
            resolveDynamicAddresses: () => fetchDiscoveryEndpoint(discoveryUrl, record.hostId),
            onDynamicUpdate: (update) => {
              void this.options.repository
                .updateAddresses(update.addresses, {
                  hostId: record.hostId,
                  port: update.port,
                  mergeExistingTunnels: false,
                })
                .then((saved) => {
                  if (!saved) return;
                  this.hosts = this.hosts.map((h) => (h.hostId === saved.hostId ? saved : h));
                  if (this.state.phase === 'paired' && this.state.record.hostId === saved.hostId) {
                    this.set({ ...this.state, record: saved, hosts: [...this.hosts] });
                  }
                })
                .catch(() => {});
            },
          }
        : {}),
      onRoundFailed: () => {
        if (this.hosts.length <= 1) return;
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures < failoverThreshold) return;
        const currentIdx = this.hosts.findIndex((h) => h.hostId === record.hostId);
        if (currentIdx === -1) return;
        const nextHost = this.hosts[(currentIdx + 1) % this.hosts.length];
        if (!nextHost || nextHost.hostId === record.hostId) return;
        // Diğer bilgisayara otomatik geçiş (Mac kapalıysa Huawei, Huawei kapalıysa Mac).
        void this.switchHost(nextHost.hostId);
      },
      onWelcome: (welcome) => {
        this.consecutiveFailures = 0;
        void this.options.repository
          .updateAddresses(welcome.addresses, {
            hostId: record.hostId,
            port: welcome.port,
            mergeExistingTunnels: true,
          })
          .then((saved) => {
            if (!saved) return;
            this.hosts = this.hosts.map((h) => (h.hostId === saved.hostId ? saved : h));
            if (this.state.phase === 'paired' && this.state.record.hostId === saved.hostId) {
              this.set({ ...this.state, record: saved, hosts: [...this.hosts] });
            }
          })
          .catch(() => {});
      },
    });
    this.set({
      phase: 'paired',
      record,
      hosts: [...this.hosts],
      manager,
      api: createRemoteApi(manager.connection),
    });
  }

  private deactivate(): void {
    if (this.state.phase === 'paired') this.state.manager.stop();
  }

  private set(state: AppState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
