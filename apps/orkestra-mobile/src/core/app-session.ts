import { createConnectionManager, type ConnectionManager } from './connection-manager';
import type { PairingPayload } from './pairing';
import { recordFromPayload, type PairingRecord, type PairingRepository } from './pairing-store';
import { createRemoteApi, type RemoteApi } from './wire-client';

export type AppState =
  | { phase: 'loading' }
  | { phase: 'unpaired' }
  | { phase: 'paired'; record: PairingRecord; manager: ConnectionManager; api: RemoteApi };

export type AppSessionOptions = {
  repository: PairingRepository;
  clientName: string;
  platform: string;
  now?: () => number;
  /** Testler için: yöneticiyi değiştirir. */
  createManager?: typeof createConnectionManager;
};

/**
 * Uygulamanın yaşam döngüsü: kayıtlı eşleşmeyi yükler, bağlantı yöneticisini başlatır/durdurur.
 * Sır yalnızca `PairingRepository` (güvenli depo) ve yönetici içinde yaşar; durum nesnesinde
 * `record.secret` bulunur ama arayüz bileşenleri onu hiçbir zaman göstermez ya da loglamaz.
 */
export class AppSession {
  private state: AppState = { phase: 'loading' };
  private readonly listeners = new Set<() => void>();
  private initStarted = false;

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
    let record: PairingRecord | null = null;
    try {
      record = await this.options.repository.load();
    } catch {
      // Güvenli depo okunamadıysa kullanıcı yeniden eşleşir.
    }
    if (record) this.activate(record);
    else this.set({ phase: 'unpaired' });
  }

  /** Önce kayıt güvenli depoya yazılır (QR tek kullanımlık), sonra bağlanılır. */
  async pair(payload: PairingPayload): Promise<void> {
    const record = recordFromPayload(payload, (this.options.now ?? Date.now)());
    await this.options.repository.save(record);
    this.deactivate();
    this.activate(record);
  }

  /** Bağlantıyı kapatır ve güvenli depodaki sırrı siler. */
  async unpair(): Promise<void> {
    this.deactivate();
    await this.options.repository.clear();
    this.set({ phase: 'unpaired' });
  }

  /** Uygulama arka plandan dönünce: ölü olabilecek soketi tazeler. */
  refresh(): void {
    if (this.state.phase === 'paired') this.state.manager.refresh();
  }

  private activate(record: PairingRecord): void {
    const create = this.options.createManager ?? createConnectionManager;
    const isReal = !this.options.createManager;
    const mdns = record.hostName?.endsWith('.local') ? [record.hostName] : [];
    const manager = create({
      record,
      clientName: this.options.clientName,
      platform: this.options.platform,
      ...(isReal ? { localCandidates: ['127.0.0.1'], fallbackCandidates: mdns } : {}),
      onWelcome: (welcome) => {
        void this.options.repository.updateAddresses(welcome.addresses).catch(() => {});
      },
    });
    this.set({ phase: 'paired', record, manager, api: createRemoteApi(manager.connection) });
  }

  private deactivate(): void {
    if (this.state.phase === 'paired') this.state.manager.stop();
  }

  private set(state: AppState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
