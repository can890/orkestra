import type { UpdateInfo } from 'electron-updater';
import { resolveAppVersion } from '@main/core/app/utils';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  lastCheck?: Date;
  nextCheck?: Date;
  currentVersion: string;
  availableVersion?: string;
  updateInfo?: UpdateInfo;
  downloadProgress?: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  };
  error?: string;
  rollbackVersion?: string;
  releaseNotes?: string;
}

export interface UpdateNotificationPublisher {
  available(version: string): void;
  downloaded(version: string): void;
  error(message: string): void;
}

// This private distribution is maintained manually. Keep the RPC contract inert.
class UpdateService {
  private state: UpdateState = { status: 'idle', currentVersion: 'unknown' };
  async initialize(): Promise<void> { this.state.currentVersion = await resolveAppVersion(); }
  setNotificationPublisher(_publisher: UpdateNotificationPublisher): void {}
  async checkForUpdates(): Promise<UpdateInfo | null> { return null; }
  async fetchReleaseNotes(): Promise<string | null> { return null; }
  async downloadUpdate(): Promise<void> { throw new Error('Orkestra güncellemeleri elle yapılır.'); }
  quitAndInstall(): void { throw new Error('Orkestra güncellemeleri elle yapılır.'); }
  getState(): UpdateState { return { ...this.state }; }
  get isInstallRequested(): boolean { return false; }
  get isActive(): boolean { return false; }
  dispose(): void {}
}
export const updateService = new UpdateService();
