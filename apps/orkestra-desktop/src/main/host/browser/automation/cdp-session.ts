import type { WebContents } from 'electron';
import { TimeoutError, withTimeout } from './timing';

const PROTOCOL_VERSION = '1.3';

/**
 * Sekmenin `webContents.debugger` (Chrome DevTools Protocol) oturumu. Tembel bağlanır;
 * yalnızca kendi bağladığı oturumu kapatır. DevTools açılması gibi nedenlerle kopan oturum bir
 * sonraki komutta yeniden bağlanır.
 */
export class CdpSession {
  private attachedByUs = false;
  private focusEmulationEnabled = false;
  private disposed = false;

  private readonly onDetach = () => {
    this.attachedByUs = false;
    this.focusEmulationEnabled = false;
  };

  constructor(private readonly webContents: WebContents) {
    webContents.debugger.on('detach', this.onDetach);
  }

  ensureAttached(): boolean {
    if (this.disposed || this.webContents.isDestroyed()) return false;
    const session = this.webContents.debugger;
    if (session.isAttached()) return true;
    try {
      session.attach(PROTOCOL_VERSION);
      this.attachedByUs = true;
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
