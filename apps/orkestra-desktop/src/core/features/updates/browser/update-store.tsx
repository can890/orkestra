import { toast } from '@orkestra/ui/react/primitives';
import { ArrowUpRight } from 'lucide-react';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import type {
  DesktopUpdateEvent,
  DesktopUpdateState,
  UpdateInstallMode,
} from '@core/features/updates/api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { getUpdatesClient } from '../api/browser/client';

const LAST_NOTIFIED_KEY = 'orkestra:update:lastNotified';
const LAST_READY_NOTIFIED_KEY = 'orkestra:update:lastReadyNotified';
const SNOOZE_HOURS = 6;

type DownloadProgress = {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; info?: { version: string } }
  | { status: 'not-available' }
  | { status: 'downloading'; progress?: DownloadProgress }
  | { status: 'downloaded' }
  | { status: 'installing' }
  | { status: 'error'; message: string };

/** Ana süreçteki güncelleme durumunu arayüz durumuna çevirir. */
export function toStoreState(data: DesktopUpdateState): UpdateState {
  switch (data.status) {
    case 'available':
      return {
        status: 'available',
        info: data.availableVersion ? { version: data.availableVersion } : undefined,
      };
    case 'downloading':
      return { status: 'downloading', progress: data.downloadProgress };
    case 'error':
      return { status: 'error', message: data.error ?? 'Güncelleme başarısız oldu.' };
    case 'idle':
    case 'checking':
    case 'not-available':
    case 'downloaded':
    case 'installing':
      return { status: data.status };
  }
}

export class UpdateStore {
  state: UpdateState = { status: 'idle' };
  currentVersion = '';
  availableVersion: string | undefined = undefined;
  /** Yeni sürümün uygulama içinde mi yoksa sürüm sayfasından elle mi kurulacağı. */
  installMode: UpdateInstallMode | undefined = undefined;
  manualReason: string | undefined = undefined;

  constructor() {
    makeObservable(this, {
      state: observable,
      currentVersion: observable,
      availableVersion: observable,
      installMode: observable,
      manualReason: observable,
      setState: action,
      hasUpdate: computed,
      progressLabel: computed,
    });
  }

  get hasUpdate(): boolean {
    const { status } = this.state;
    return status === 'available' || status === 'downloading' || status === 'downloaded';
  }

  setState(state: UpdateState): void {
    this.state = state;
  }

  get progressLabel(): string {
    if (this.state.status !== 'downloading') return '';
    const p = this.state.progress?.percent ?? 0;
    return `%${p.toFixed(0)}`;
  }

  start(): void {
    void this._startWire();

    void getHostClient().then((client) => {
      void client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.type === 'menu-check-for-updates') void this.check();
        },
        onGap: () => {},
      });
    });
  }

  async check(): Promise<void> {
    runInAction(() => {
      this.state = { status: 'checking' };
    });
    try {
      const client = await getUpdatesClient();
      const res = await client.check(undefined);
      if (!res) {
        runInAction(() => {
          this.state = { status: 'error', message: 'Update API unavailable' };
        });
        return;
      }
      if (!res.success) {
        runInAction(() => {
          this.state = { status: 'error', message: res.error ?? 'Failed to check for updates' };
        });
        return;
      }
      // The main process may already hold a downloaded update or have started downloading.
      await this._refreshWireState();
    } catch {
      runInAction(() => {
        this.state = { status: 'error', message: 'Failed to check for updates' };
      });
    }
  }

  async download(): Promise<void> {
    try {
      const client = await getUpdatesClient();
      const res = await client.download(undefined);
      if (!res) {
        runInAction(() => {
          this.state = { status: 'error', message: 'Update API unavailable' };
        });
        return;
      }
      if (!res.success) {
        const message = res.error ?? 'Failed to download update';
        runInAction(() => {
          this.state = { status: 'error', message };
        });
      }
    } catch {
      runInAction(() => {
        this.state = { status: 'error', message: 'Failed to download update' };
      });
    }
  }

  async install(): Promise<void> {
    runInAction(() => {
      this.state = { status: 'installing' };
    });
    try {
      const client = await getUpdatesClient();
      const res = await client.quitAndInstall(undefined);
      if (!res) {
        runInAction(() => {
          this.state = { status: 'error', message: 'Update API unavailable' };
        });
        return;
      }
      if (!res.success) {
        runInAction(() => {
          this.state = { status: 'error', message: res.error ?? 'Failed to install update' };
        });
      }
    } catch {
      runInAction(() => {
        this.state = { status: 'error', message: 'Failed to install update' };
      });
    }
  }

  async openLatest(): Promise<void> {
    try {
      const client = await getUpdatesClient();
      await client.openLatest(undefined);
    } catch {
      // Opening the release page in the browser is best-effort.
    }
  }

  /** Bildirime tıklanınca: elle kurulumda sürüm sayfası açılır, uygulama içinde indirme başlar. */
  async runPrimaryAction(): Promise<void> {
    if (this.installMode !== 'in-app') {
      await this.openLatest();
      return;
    }
    const { status } = this.state;
    if (status === 'available' || (status === 'error' && this.availableVersion)) {
      await this.download();
    }
  }

  private async _startWire(): Promise<void> {
    const client = await getUpdatesClient();
    await client.events.subscribe(undefined, {
      onEvent: (event) => this._applyEvent(event),
      onGap: () => void this._refreshWireState(),
    });
    await this._refreshWireState();
    await this.check();
  }

  private async _refreshWireState(): Promise<void> {
    const client = await getUpdatesClient();
    const result = await client.getState(undefined);
    if (!result.success) return;
    runInAction(() => {
      this.currentVersion = result.data.currentVersion;
      this.availableVersion = result.data.availableVersion;
      this.installMode = result.data.installMode;
      this.manualReason = result.data.manualReason;
      this.state = toStoreState(result.data);
    });
  }

  private _applyEvent(event: DesktopUpdateEvent): void {
    runInAction(() => {
      switch (event.type) {
        case 'checking':
          this.state = { status: 'checking' };
          break;
        case 'available':
          this.availableVersion = event.version;
          if (event.installMode) {
            this.installMode = event.installMode;
            this.manualReason = event.manualReason;
          }
          this.state = { status: 'available', info: { version: event.version } };
          break;
        case 'not-available':
          this.state = { status: 'not-available' };
          break;
        case 'downloading':
          this.availableVersion = event.version;
          this.installMode = 'in-app';
          this.state = { status: 'downloading', progress: { percent: 0 } };
          break;
        case 'progress':
          this.state = {
            status: 'downloading',
            progress: {
              percent: event.percent,
              transferred: event.transferred,
              total: event.total,
              bytesPerSecond: event.bytesPerSecond,
            },
          };
          break;
        case 'downloaded':
          this.availableVersion = event.version;
          this.installMode = 'in-app';
          this.state = { status: 'downloaded' };
          break;
        case 'installing':
          this.state = { status: 'installing' };
          break;
        case 'error':
          this.state = { status: 'error', message: event.message };
          break;
      }
    });
    if (event.type === 'available' && !event.autoDownload) {
      this._maybeToast(LAST_NOTIFIED_KEY, event.version, () =>
        event.installMode === 'in-app'
          ? this._showDownloadToast(event.version)
          : this._showManualToast(event.version)
      );
    }
    if (event.type === 'downloaded') {
      this._maybeToast(LAST_READY_NOTIFIED_KEY, event.version, () =>
        this._showReadyToast(event.version)
      );
    }
    // A refused package switches to the manual flow; refresh so the card shows the reason.
    if (event.type === 'error') void this._refreshWireState();
  }

  private _maybeToast(key: string, version: string, show: () => void): void {
    if (!this._shouldNotify(key, version)) return;
    show();
    this._rememberNotified(key, version);
  }

  private _showManualToast(version: string): void {
    toast('Yeni sürüm var', {
      description: `Orkestra ${version} yayımlandı. İndirip Applications klasöründeki uygulamayla değiştirebilirsiniz.`,
      duration: 10_000,
      action: {
        label: (
          <span className="flex items-center gap-1.5">
            Sürüm sayfasını aç
            <ArrowUpRight className="size-3.5" />
          </span>
        ),
        onClick: () => {
          getNavigation().navigate(settingsViewDef({ tab: 'general' }));
          void this.openLatest();
        },
      },
    });
  }

  private _showDownloadToast(version: string): void {
    toast('Yeni sürüm var', {
      description: `Orkestra ${version} yayımlandı. İndirilip doğrulandıktan sonra yeniden başlatınca kurulur.`,
      duration: 10_000,
      action: {
        label: 'İndir',
        onClick: () => {
          getNavigation().navigate(settingsViewDef({ tab: 'general' }));
          void this.download();
        },
      },
    });
  }

  private _showReadyToast(version: string): void {
    toast('Güncelleme hazır', {
      description: `Orkestra ${version} indirildi ve doğrulandı. Yeniden başlatınca kurulur.`,
      duration: 15_000,
      action: {
        label: 'Yeniden başlat ve güncelle',
        onClick: () => void this.install(),
      },
    });
  }

  private _shouldNotify(key: string, version: string): boolean {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return true;
      const parsed = JSON.parse(raw) as { version?: string; at?: number };
      if (parsed.version === version) {
        const at = parsed.at ?? 0;
        if (Date.now() - at < Math.max(1, SNOOZE_HOURS) * 3_600_000) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private _rememberNotified(key: string, version: string): void {
    try {
      localStorage.setItem(key, JSON.stringify({ version, at: Date.now() }));
    } catch {
      // localStorage may be unavailable
    }
  }
}
