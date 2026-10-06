import { app, net, shell } from 'electron';
import type { DesktopUpdateEvent, UpdateInstallMode } from '@core/features/updates/api';
import { updateEvents } from '@core/features/updates/node';
import { ORKESTRA_RELEASES_URL } from '@core/primitives/urls/api/urls';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import { resolveAppVersion, spawnDetachedCommand } from '@main/core/app/utils';
import { log } from '@main/lib/logger';
import { UpdateRefusedError } from './code-signature';
import type { InstallSupport } from './install-location';
import {
  execFileCollect,
  MacInAppInstaller,
  type InAppInstaller,
  type PreparedUpdate,
  type ReleaseAsset,
} from './mac-installer';
import { compareVersions, formatUpdaterError, parseVersion } from './utils';

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/can890/orkestra/releases/latest';
const LATEST_RELEASE_PAGE_URL = `${ORKESTRA_RELEASES_URL}/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The GitHub release a newer version was found in. */
export interface ReleaseInfo {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  releaseUrl: string;
}

export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
  lastCheck?: Date;
  nextCheck?: Date;
  currentVersion: string;
  availableVersion?: string;
  updateInfo?: ReleaseInfo;
  downloadProgress?: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  };
  error?: string;
  rollbackVersion?: string;
  releaseNotes?: string;
  installMode?: UpdateInstallMode;
  manualReason?: string;
}

export interface UpdateNotificationPublisher {
  available(version: string): void;
  downloaded(version: string): void;
  error(message: string): void;
}

export interface UpdateServiceDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  openExternal(url: string): Promise<void>;
  resolveVersion(): Promise<string>;
  emit(event: DesktopUpdateEvent): void;
  /** "Güncellemeleri otomatik indir" ayarı. */
  getAutoDownload(): Promise<boolean>;
  installer: InAppInstaller;
  /** Kurulum yardımcısı başlatıldıktan sonra uygulamayı kapatır. */
  quit(): void;
}

const defaultDeps: UpdateServiceDeps = {
  fetch: (url, init) => net.fetch(url, init),
  openExternal: (url) => shell.openExternal(url),
  resolveVersion: resolveAppVersion,
  emit: (event) => updateEvents.emit(undefined, event),
  getAutoDownload: async () => {
    try {
      return (await getAppSettingsService().get('updates')).autoDownload;
    } catch {
      // Kurtarma modunda ayar hizmeti başlatılmamış olabilir; varsayılan açıktır.
      return true;
    }
  },
  installer: new MacInAppInstaller({
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    isPackaged: () => app.isPackaged,
    exePath: () => app.getPath('exe'),
    userDataDir: () => app.getPath('userData'),
    tempDir: () => app.getPath('temp'),
    userAgent: () => `Orkestra/${app.getVersion()}`,
    fetch: (url, init) => net.fetch(url, init),
    exec: execFileCollect,
    spawnDetached: (file, args) => spawnDetachedCommand(file, [...args]),
  }),
  quit: () => app.quit(),
};

type LatestRelease = { info: ReleaseInfo; notes?: string; assets: ReleaseAsset[] };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Only release pages of this repository are opened; anything else falls back to /latest. */
function releasePageUrl(value: unknown): string {
  return typeof value === 'string' && value.startsWith(`${ORKESTRA_RELEASES_URL}/`)
    ? value
    : LATEST_RELEASE_PAGE_URL;
}

function parseAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const asset = raw as Record<string, unknown>;
    const name = optionalString(asset.name);
    const url = optionalString(asset.browser_download_url);
    if (!name || !url) return [];
    const size = typeof asset.size === 'number' && asset.size > 0 ? asset.size : undefined;
    return [{ name, url, size }];
  });
}

/** Kurulum hatalarını kullanıcıya gösterilecek kısa Türkçe metne çevirir. */
export function describeInstallError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC') return 'Güncellemeyi indirmek için diskte yeterli boş alan yok.';
  if (code === 'EACCES' || code === 'EPERM') return 'Güncelleme dosyalarına yazma izni yok.';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const collapsed = message.replace(/\s+/g, ' ').trim() || 'Güncelleme kurulamadı.';
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

/**
 * Checks the latest GitHub release against the running version every six hours.
 *
 * When the app runs from a writable location with the stable signing identity, a newer version
 * is downloaded in-app (orkestra-<arch>.zip), verified against the release's SHA256SUMS and the
 * running app's designated requirement, and installed on "Yeniden başlat ve güncelle" by a
 * detached helper that swaps the bundle after the app quits (see install-script.ts). Otherwise
 * — ad-hoc builds, translocated or read-only locations, refused packages — the service falls
 * back to opening the release page for a manual download.
 *
 * States: idle → checking → available | not-available; available → downloading → downloaded
 * → installing (app quits). Any failure moves to error while keeping availableVersion, so the
 * UI can offer a retry or the manual release page.
 */
export class UpdateService {
  private state: UpdateState = { status: 'idle', currentVersion: 'unknown' };
  private publisher: UpdateNotificationPublisher | null = null;
  private inflight: Promise<ReleaseInfo | null> | null = null;
  private downloadInflight: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private notifiedVersion: string | null = null;
  private latestAssets: readonly ReleaseAsset[] = [];
  private prepared: PreparedUpdate | null = null;
  private support: InstallSupport | null = null;
  private supportInflight: Promise<InstallSupport> | null = null;
  private installRequested = false;
  private pendingInstallFailure: string | null = null;

  constructor(private readonly deps: UpdateServiceDeps = defaultDeps) {}

  async initialize(): Promise<void> {
    // Idempotent: recovery mode may call it again after a later boot phase failed.
    if (this.initialized) return;
    this.initialized = true;
    this.state.currentVersion = await this.deps.resolveVersion();
    await this.restorePreviousInstall();
    void this.resolveSupport();
    // The renderer checks once on startup; long-running sessions are re-checked here.
    this.interval = setInterval(() => void this.backgroundCheck(), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  setNotificationPublisher(publisher: UpdateNotificationPublisher): void {
    this.publisher = publisher;
    if (this.pendingInstallFailure) {
      publisher.error(this.pendingInstallFailure);
      this.pendingInstallFailure = null;
    }
  }

  /** Concurrent callers share one request. Resolves to the newer release, or null. */
  checkForUpdates(): Promise<ReleaseInfo | null> {
    this.inflight ??= this.runCheck().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async fetchReleaseNotes(): Promise<string | null> {
    return this.state.releaseNotes ?? null;
  }

  /**
   * Downloads and verifies the newer version in-app. Where an in-app install is impossible the
   * release page is opened instead, as before.
   */
  async downloadUpdate(): Promise<void> {
    if (this.state.status === 'downloaded' || this.state.status === 'installing') return;
    if (!this.state.availableVersion) {
      const found = await this.checkForUpdates();
      if (!found) return;
      // The check may have restored an update downloaded earlier in this session.
      if (this.getState().status === 'downloaded') return;
    }
    const support = await this.resolveSupport();
    if (!support.supported) {
      await this.openReleasePage();
      return;
    }
    await this.startDownload();
  }

  async openReleasePage(): Promise<void> {
    await this.deps.openExternal(this.state.updateInfo?.releaseUrl ?? LATEST_RELEASE_PAGE_URL);
  }

  /** Starts the detached install helper and quits; the helper swaps the bundle and relaunches. */
  async quitAndInstall(): Promise<void> {
    const prepared = this.prepared;
    if (this.state.status !== 'downloaded' || !prepared) {
      throw new Error('Kurulmaya hazır bir güncelleme yok. Önce güncellemeyi indirin.');
    }
    if (!(await this.deps.installer.isPrepared(prepared))) {
      this.prepared = null;
      this.state = { ...this.state, status: 'available' };
      this.deps.emit({ type: 'available', version: prepared.version, installMode: 'in-app' });
      throw new Error('İndirilen güncelleme dosyaları bulunamadı; güncellemeyi yeniden indirin.');
    }
    this.state = { ...this.state, status: 'installing', error: undefined };
    this.deps.emit({ type: 'installing' });
    try {
      await this.deps.installer.launchInstaller(prepared);
    } catch (error) {
      this.state = { ...this.state, status: 'downloaded' };
      this.deps.emit({ type: 'downloaded', version: prepared.version });
      throw new Error(`Kurulum yardımcısı başlatılamadı: ${describeInstallError(error)}`);
    }
    this.installRequested = true;
    log.info('Update: install helper started, quitting', { version: prepared.version });
    this.deps.quit();
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  get isInstallRequested(): boolean {
    return this.installRequested;
  }

  /** Recovery mode offers in-app download/install only where the bundle can be replaced. */
  get isActive(): boolean {
    return this.support?.supported === true;
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async restorePreviousInstall(): Promise<void> {
    try {
      const failure = await this.deps.installer.takeInstallFailure();
      if (failure) {
        const message = `Son güncelleme kurulamadı: ${failure}`;
        log.warn('Update: previous install failed', { failure });
        this.state = { ...this.state, status: 'error', error: message };
        if (this.publisher) this.publisher.error(message);
        else this.pendingInstallFailure = message;
      }
      await this.deps.installer.cleanup(this.state.currentVersion);
    } catch (error) {
      log.warn('Update: failed to inspect previous install', {
        error: describeInstallError(error),
      });
    }
  }

  private resolveSupport(): Promise<InstallSupport> {
    if (this.support) return Promise.resolve(this.support);
    this.supportInflight ??= this.deps.installer
      .checkSupport()
      .catch(
        (error: unknown): InstallSupport => ({
          supported: false,
          reason: describeInstallError(error),
        })
      )
      .then((support) => {
        this.support ??= support;
        if (!support.supported) log.info('Update: in-app install unavailable', support);
        return this.support;
      })
      .finally(() => {
        this.supportInflight = null;
      });
    return this.supportInflight;
  }

  private startDownload(): Promise<void> {
    this.downloadInflight ??= this.runDownload().finally(() => {
      this.downloadInflight = null;
    });
    return this.downloadInflight;
  }

  private async runDownload(): Promise<void> {
    const version = this.state.availableVersion;
    if (!version) throw new Error('İndirilecek yeni bir sürüm yok.');
    this.state = {
      ...this.state,
      status: 'downloading',
      error: undefined,
      downloadProgress: { bytesPerSecond: 0, percent: 0, transferred: 0, total: 0 },
    };
    this.deps.emit({ type: 'downloading', version });
    try {
      const prepared = await this.deps.installer.prepare(
        { version, assets: this.latestAssets },
        (progress) => {
          if (this.state.status !== 'downloading') return;
          this.state = { ...this.state, downloadProgress: progress };
          this.deps.emit({ type: 'progress', ...progress });
        }
      );
      this.prepared = prepared;
      this.state = { ...this.state, status: 'downloaded', downloadProgress: undefined };
      this.deps.emit({ type: 'downloaded', version });
      this.publisher?.downloaded(version);
    } catch (error) {
      const message = describeInstallError(error);
      log.warn('Update: download failed', { version, error: message });
      if (error instanceof UpdateRefusedError) {
        // Reddedilen paket yeniden denenmez; kullanıcı sürüm sayfasından elle kurabilir.
        this.support = { supported: false, reason: message };
        this.state = { ...this.state, installMode: 'manual', manualReason: message };
      }
      this.state = { ...this.state, status: 'error', error: message, downloadProgress: undefined };
      this.deps.emit({ type: 'error', message });
      throw error instanceof UpdateRefusedError ? error : new Error(message);
    }
  }

  private async backgroundCheck(): Promise<void> {
    try {
      await this.checkForUpdates();
    } catch (error) {
      log.warn('Update check failed', { error: formatUpdaterError(error) });
    }
  }

  private async runCheck(): Promise<ReleaseInfo | null> {
    // A download or install in progress owns the state; the next check picks up from there.
    if (this.state.status === 'downloading' || this.state.status === 'installing') {
      return this.state.updateInfo ?? null;
    }
    const previous = this.state;
    this.state = { ...this.state, status: 'checking', error: undefined };
    this.deps.emit({ type: 'checking' });
    try {
      const latest = await this.fetchLatestRelease();
      const comparison = compareVersions(latest.info.version, this.state.currentVersion);
      if (comparison === null) {
        throw new Error(
          `Sürümler karşılaştırılamadı (${latest.info.version} / ${this.state.currentVersion}).`
        );
      }
      const lastCheck = new Date();
      const nextCheck = new Date(lastCheck.getTime() + CHECK_INTERVAL_MS);
      if (comparison > 0) {
        return await this.handleNewerRelease(latest, lastCheck, nextCheck);
      }
      this.prepared = null;
      this.state = {
        ...this.state,
        status: 'not-available',
        availableVersion: undefined,
        updateInfo: undefined,
        releaseNotes: undefined,
        lastCheck,
        nextCheck,
      };
      this.deps.emit({ type: 'not-available' });
      return null;
    } catch (error) {
      if (previous.status === 'downloaded' && this.prepared) {
        // A verified update stays ready to install even when a later check fails.
        log.warn('Update check failed; keeping the downloaded update', {
          error: formatUpdaterError(error),
        });
        this.state = { ...previous, lastCheck: new Date() };
        this.deps.emit({ type: 'downloaded', version: this.prepared.version });
        return previous.updateInfo ?? null;
      }
      const message = formatUpdaterError(error);
      // A version found by an earlier check stays available; the card shows the error beside it.
      this.state = { ...this.state, status: 'error', error: message, lastCheck: new Date() };
      this.deps.emit({ type: 'error', message });
      throw error;
    }
  }

  private async handleNewerRelease(
    latest: LatestRelease,
    lastCheck: Date,
    nextCheck: Date
  ): Promise<ReleaseInfo> {
    const { version } = latest.info;
    const support = await this.resolveSupport();
    const installMode: UpdateInstallMode = support.supported ? 'in-app' : 'manual';
    const manualReason = support.supported ? undefined : support.reason;
    this.latestAssets = latest.assets;
    const prepared = this.prepared;
    const ready =
      prepared !== null &&
      prepared.version === version &&
      (await this.deps.installer.isPrepared(prepared));
    if (!ready) this.prepared = null;
    this.state = {
      ...this.state,
      status: ready ? 'downloaded' : 'available',
      availableVersion: version,
      updateInfo: latest.info,
      releaseNotes: latest.notes,
      downloadProgress: undefined,
      installMode,
      manualReason,
      lastCheck,
      nextCheck,
    };
    if (ready) {
      this.deps.emit({ type: 'downloaded', version });
      return latest.info;
    }
    const autoDownload = installMode === 'in-app' && (await this.deps.getAutoDownload());
    this.deps.emit({ type: 'available', version, installMode, manualReason, autoDownload });
    // One system notification per version and session; the renderer snoozes its own toast.
    if (this.notifiedVersion !== version) {
      this.notifiedVersion = version;
      this.publisher?.available(version);
    }
    if (autoDownload) {
      // Errors are reported through the state and events; nothing awaits the background download.
      void this.startDownload().catch(() => undefined);
    }
    return latest.info;
  }

  private async fetchLatestRelease(): Promise<LatestRelease> {
    let response: Response;
    try {
      response = await this.deps.fetch(LATEST_RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Orkestra/${this.state.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Re-wrapped so network and timeout codes aren't reported as HTTP statuses.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub'a ulaşılamadı: ${reason}`);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 403 || response.status === 429
          ? 'GitHub istek sınırına ulaşıldı. Biraz sonra yeniden deneyin.'
          : `GitHub sürüm bilgisi alınamadı (HTTP ${response.status}).`
      );
    }
    const release = (await response.json()) as Record<string, unknown>;
    const tag = optionalString(release.tag_name) ?? '';
    const version = tag.replace(/^v/, '');
    if (!parseVersion(version)) {
      throw new Error(`Son sürümün etiketi okunamadı (${tag || 'etiket yok'}).`);
    }
    return {
      info: {
        version,
        releaseName: optionalString(release.name),
        releaseDate: optionalString(release.published_at),
        releaseUrl: releasePageUrl(release.html_url),
      },
      notes: optionalString(release.body),
      assets: parseAssets(release.assets),
    };
  }
}

export const updateService = new UpdateService();
