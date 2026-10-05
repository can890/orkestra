import { net, shell } from 'electron';
import type { DesktopUpdateEvent } from '@core/features/updates/api';
import { updateEvents } from '@core/features/updates/node';
import { ORKESTRA_RELEASES_URL } from '@core/primitives/urls/api/urls';
import { resolveAppVersion } from '@main/core/app/utils';
import { log } from '@main/lib/logger';
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
}

const defaultDeps: UpdateServiceDeps = {
  fetch: (url, init) => net.fetch(url, init),
  openExternal: (url) => shell.openExternal(url),
  resolveVersion: resolveAppVersion,
  emit: (event) => updateEvents.emit(undefined, event),
};

type LatestRelease = { info: ReleaseInfo; notes?: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Only release pages of this repository are opened; anything else falls back to /latest. */
function releasePageUrl(value: unknown): string {
  return typeof value === 'string' && value.startsWith(`${ORKESTRA_RELEASES_URL}/`)
    ? value
    : LATEST_RELEASE_PAGE_URL;
}

/**
 * Releases are published by hand on GitHub and builds are ad-hoc signed, so an in-place install
 * is impossible. The service compares the latest GitHub release with the running version,
 * reports newer versions, and opens the release page for a manual download. The app never quits
 * on its own.
 */
export class UpdateService {
  private state: UpdateState = { status: 'idle', currentVersion: 'unknown' };
  private publisher: UpdateNotificationPublisher | null = null;
  private inflight: Promise<ReleaseInfo | null> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private notifiedVersion: string | null = null;

  constructor(private readonly deps: UpdateServiceDeps = defaultDeps) {}

  async initialize(): Promise<void> {
    // Idempotent: recovery mode may call it again after a later boot phase failed.
    if (this.initialized) return;
    this.initialized = true;
    this.state.currentVersion = await this.deps.resolveVersion();
    // The renderer checks once on startup; long-running sessions are re-checked here.
    this.interval = setInterval(() => void this.backgroundCheck(), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  setNotificationPublisher(publisher: UpdateNotificationPublisher): void {
    this.publisher = publisher;
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

  /** There is nothing to download in-app: the release page offers the DMG and ZIP. */
  async downloadUpdate(): Promise<void> {
    await this.openReleasePage();
  }

  async openReleasePage(): Promise<void> {
    await this.deps.openExternal(this.state.updateInfo?.releaseUrl ?? LATEST_RELEASE_PAGE_URL);
  }

  quitAndInstall(): void {
    throw new Error(
      'Orkestra güncellemeleri elle kurulur: yeni sürümü indirip Applications klasörüne sürükleyin.'
    );
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  get isInstallRequested(): boolean {
    return false;
  }

  /** Recovery mode only offers in-app download/install flows, which this service doesn't have. */
  get isActive(): boolean {
    return false;
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async backgroundCheck(): Promise<void> {
    try {
      await this.checkForUpdates();
    } catch (error) {
      log.warn('Update check failed', { error: formatUpdaterError(error) });
    }
  }

  private async runCheck(): Promise<ReleaseInfo | null> {
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
        this.state = {
          ...this.state,
          status: 'available',
          availableVersion: latest.info.version,
          updateInfo: latest.info,
          releaseNotes: latest.notes,
          lastCheck,
          nextCheck,
        };
        this.deps.emit({ type: 'available', version: latest.info.version });
        // One system notification per version and session; the renderer snoozes its own toast.
        if (this.notifiedVersion !== latest.info.version) {
          this.notifiedVersion = latest.info.version;
          this.publisher?.available(latest.info.version);
        }
        return latest.info;
      }
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
      const message = formatUpdaterError(error);
      // A version found by an earlier check stays available; the card shows the error beside it.
      this.state = { ...this.state, status: 'error', error: message, lastCheck: new Date() };
      this.deps.emit({ type: 'error', message });
      throw error;
    }
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
    };
  }
}

export const updateService = new UpdateService();
