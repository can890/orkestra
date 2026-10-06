import type { WebContents } from 'electron';
import { TimeoutError, withTimeout } from './timing';

const PROTOCOL_VERSION = '1.3';

/** CDP olay dinleyicisi: yöntem adı (ör. "Network.requestWillBeSent") ve parametreleri. */
export type CdpEventListener = (method: string, params: Record<string, unknown>) => void;

/**
 * Sekmenin `webContents.debugger` (Chrome DevTools Protocol) oturumu. Tembel bağlanır;
 * yalnızca kendi bağladığı oturumu kapatır. DevTools açılması gibi nedenlerle kopan oturum bir
 * sonraki komutta yeniden bağlanır.
 */
export class CdpSession {
  private attachedByUs = false;
  private focusEmulationEnabled = false;
  private disposed = false;
  private readonly eventListeners = new Set<CdpEventListener>();
  /** Etkinleştirilen olay alanları (ör. "Network.enable"); yeniden bağlanınca tekrar gönderilir. */
  private readonly enabledDomains = new Map<string, Record<string, unknown>>();

  private readonly onDetach = () => {
    this.attachedByUs = false;
    this.focusEmulationEnabled = false;
  };

  private readonly onMessage = (_event: unknown, method: unknown, params: unknown) => {
    if (typeof method !== 'string') return;
    const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    for (const listener of [...this.eventListeners]) {
      try {
        listener(method, record);
      } catch {
        // Bir dinleyicinin hatası diğerlerini ve oturumu etkilememeli.
      }
    }
  };

  constructor(private readonly webContents: WebContents) {
    webContents.debugger.on('detach', this.onDetach);
    webContents.debugger.on('message', this.onMessage);
  }

  ensureAttached(): boolean {
    if (this.disposed || this.webContents.isDestroyed()) return false;
    const session = this.webContents.debugger;
    if (session.isAttached()) return true;
    try {
      session.attach(PROTOCOL_VERSION);
      this.attachedByUs = true;
    } catch {
      return false;
    }
    // Kopan oturumla birlikte olay alanları da kapandı; yeni oturumda yeniden aç.
    for (const [method, params] of this.enabledDomains) {
      session.sendCommand(method, params).catch(() => undefined);
    }
    return true;
  }

  /** CDP olaylarını dinler; dönen fonksiyon dinleyiciyi kaldırır. */
  onEvent(listener: CdpEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Bir olay alanını etkinleştirir (ör. "Network.enable") ve oturum yeniden bağlandığında
   * tekrar gönderilmek üzere hatırlar. Başarısızlık (DevTools kullanılamıyor) false döndürür.
   */
  async enableDomain(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<boolean> {
    if (!this.ensureAttached()) return false;
    this.enabledDomains.set(method, params);
    try {
      await this.send(method, params, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async send<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.ensureAttached()) {
      throw new Error('The DevTools protocol is not available for this tab.');
    }
    const result: unknown = await withTimeout(
      this.webContents.debugger.sendCommand(method, params),
      timeoutMs,
      () => new TimeoutError(`DevTools command ${method} timed out after ${timeoutMs} ms.`)
    );
    return result as T;
  }

  /**
   * Sayfayı odaklıymış gibi davranmaya zorlar (Emulation.setFocusEmulationEnabled). Böylece
   * sekme arka plandayken de odak olayları çalışır ve gömücü (embedder) odağı geri verildiğinde
   * sayfa blur almaz. Ayar gezinmeler ve yeniden yüklemeler boyunca korunur.
   */
  async enableFocusEmulation(timeoutMs: number): Promise<boolean> {
    if (this.focusEmulationEnabled && this.webContents.debugger.isAttached()) return true;
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, timeoutMs);
      this.focusEmulationEnabled = true;
    } catch {
      this.focusEmulationEnabled = false;
    }
    return this.focusEmulationEnabled;
  }

  /** Çökme sonrası yeni işleyici süreci için öykünmenin yeniden gönderilmesini sağlar. */
  resetEmulationState(): void {
    this.focusEmulationEnabled = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.webContents.isDestroyed()) return;
    const session = this.webContents.debugger;
    session.removeListener('detach', this.onDetach);
    session.removeListener('message', this.onMessage);
    this.eventListeners.clear();
    if (!this.attachedByUs || !session.isAttached()) return;
    if (this.focusEmulationEnabled) {
      session
        .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
        .catch(() => undefined);
    }
    try {
      session.detach();
    } catch {
      // Oturum zaten kapanmış olabilir.
    }
  }
}
