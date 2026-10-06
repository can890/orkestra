import * as React from 'react';
import { Box } from '../../primitives/box';
import { Button } from '../../primitives/button';
import { useAsyncAction } from '../../primitives/hooks/use-async-action';
import { Pill } from '../pill/pill';
import { StatusIcon } from '../status-icon/status-icon';
import * as styles from './update-card.css';

export type UpdateStatus =
  | { type: 'up-to-date' }
  /** No check has completed yet, so the card can't claim the version is current. */
  | { type: 'not-checked' }
  | { type: 'checking' }
  /** The last check failed, so whether a newer version exists is unknown. */
  | { type: 'check-failed' }
  /** A newer version must be downloaded and installed by hand (e.g. from a release page). */
  | { type: 'manual-download'; version: string; onOpen: () => Promise<void>; reason?: string }
  /**
   * Yeni sürüm uygulama içinde indirilebilir (otomatik indirme kapalı ya da önceki deneme
   * başarısız oldu; `retry` ikinci durumu belirtir).
   */
  | {
      type: 'download-available';
      version: string;
      onDownload: () => Promise<void>;
      onOpenRelease?: () => Promise<void>;
      retry?: boolean;
    }
  /** Yeni sürüm uygulama içinde indiriliyor; `percent` 0–100 arasıdır. */
  | {
      type: 'downloading';
      version: string;
      percent: number;
      onOpenRelease?: () => Promise<void>;
    }
  /** Yeni sürüm indirilip doğrulandı; yeniden başlatınca kurulur. */
  | {
      type: 'ready-to-restart';
      version: string;
      onInstall: () => Promise<void>;
      onOpenRelease?: () => Promise<void>;
    }
  /** Uygulama kapanıp yeni sürümle yeniden açılıyor. */
  | { type: 'installing' }
  | { type: 'update-available'; version: string; onUpdate: () => Promise<void> }
  | {
      type: 'update-download-available';
      version: string;
      size: number;
      onDownload: (onProgress: (progress: number) => void, cancel?: () => void) => Promise<void>;
    }
  | { type: 'update-install-available'; onInstall: () => Promise<void> };

export interface UpdateCardProps {
  currentVersion: string;
  status: UpdateStatus;
  appName: string;
  onCheckForUpdates: () => Promise<void>;
  /** Error from the most recent action (check / download / install). */
  error?: { message: string };
}

export function UpdateCard({
  currentVersion,
  status,
  appName = 'app',
  onCheckForUpdates,
  error,
}: UpdateCardProps) {
  const [downloadProgress, setDownloadProgress] = React.useState<number>(0);

  const onProgress = (progress: number) => {
    setDownloadProgress(progress);
  };

  const [checkForUpdates, , isCheckingForUpdates] = useAsyncAction(async () => {
    await onCheckForUpdates();
  });
  const [downloadUpdate, , isDownloading] = useAsyncAction(async () => {
    if (status.type !== 'update-download-available') return;
    await status.onDownload(onProgress);
  });
  const [updateNow, , isUpdating] = useAsyncAction(async () => {
    if (status.type !== 'update-available') return;
    await status.onUpdate();
  });
  const [installUpdate, , isInstalling] = useAsyncAction(async () => {
    if (status.type !== 'update-install-available') return;
    await status.onInstall();
  });
  const [openDownload, , isOpeningDownload] = useAsyncAction(async () => {
    if (status.type !== 'manual-download') return;
    await status.onOpen();
  });
  const [downloadInApp, , isStartingDownload] = useAsyncAction(async () => {
    if (status.type !== 'download-available') return;
    await status.onDownload();
  });
  const [restartAndInstall, , isRestarting] = useAsyncAction(async () => {
    if (status.type !== 'ready-to-restart') return;
    await status.onInstall();
  });
  const openReleaseAction =
    'onOpenRelease' in status && status.onOpenRelease ? status.onOpenRelease : undefined;
  const [openRelease, , isOpeningRelease] = useAsyncAction(async () => {
    await openReleaseAction?.();
  });

  React.useEffect(() => {
    setDownloadProgress(0);
  }, [status.type]);

  const renderActionButton = () => {
    switch (status.type) {
      case 'up-to-date':
      case 'not-checked':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={checkForUpdates}
            disabled={isCheckingForUpdates}
            aria-busy={isCheckingForUpdates}
          >
            {isCheckingForUpdates ? 'Checking...' : 'Check for updates'}
          </Button>
        );
      case 'checking':
        return (
          <Button variant="secondary" size="xs" disabled aria-busy>
            Checking...
          </Button>
        );
      case 'check-failed':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={checkForUpdates}
            disabled={isCheckingForUpdates}
            aria-busy={isCheckingForUpdates}
          >
            {isCheckingForUpdates ? 'Checking...' : 'Retry'}
          </Button>
        );
      case 'manual-download':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={openDownload}
            disabled={isOpeningDownload}
            aria-busy={isOpeningDownload}
          >
            Download
          </Button>
        );
      case 'update-available':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={updateNow}
            disabled={isUpdating}
            aria-busy={isUpdating}
          >
            {isUpdating ? 'Updating...' : 'Update'}
          </Button>
        );
      case 'update-download-available':
        return (
          <DownloadButton
            onClick={downloadUpdate}
            isDownloading={isDownloading}
            progress={downloadProgress}
          />
        );
      case 'update-install-available':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={installUpdate}
            disabled={isInstalling}
            aria-busy={isInstalling}
          >
            {isInstalling ? 'Restarting...' : 'Restart'}
          </Button>
        );
      case 'download-available':
        return (
          <Button
            variant="secondary"
            size="xs"
            onClick={downloadInApp}
            disabled={isStartingDownload}
            aria-busy={isStartingDownload}
          >
            {status.retry ? 'Yeniden dene' : 'İndir'}
          </Button>
        );
      case 'downloading': {
        const percent = clampPercent(status.percent);
        return (
          <>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="İndirme ilerlemesi"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className={styles.progressFill} style={{ width: `${percent}%` }} />
            </div>
            <Button variant="secondary" size="xs" disabled aria-busy>
              {`İndiriliyor %${percent}`}
            </Button>
          </>
        );
      }
      case 'ready-to-restart':
        return (
          <Button
            variant="primary"
            size="xs"
            onClick={restartAndInstall}
            disabled={isRestarting}
            aria-busy={isRestarting}
          >
            {isRestarting ? 'Yeniden başlatılıyor…' : 'Yeniden başlat ve güncelle'}
          </Button>
        );
      case 'installing':
        return (
          <Button variant="secondary" size="xs" disabled aria-busy>
            Yeniden başlatılıyor…
          </Button>
        );
    }
  };

  const renderReleaseLink = () => {
    if (!openReleaseAction) return null;
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={openRelease}
        disabled={isOpeningRelease}
        aria-busy={isOpeningRelease}
      >
        Sürüm sayfasını aç
      </Button>
    );
  };

  const renderStatusLabel = () => {
    switch (status.type) {
      case 'up-to-date':
        return "You're up to date";
      case 'not-checked':
        return "Updates haven't been checked yet";
      case 'checking':
        return 'Checking for updates';
      case 'check-failed':
        return "Couldn't check for updates";
      case 'update-install-available':
        return 'Update ready to install';
      case 'download-available':
        return status.retry ? 'Güncelleme indirilemedi' : 'Yeni sürüm var';
      case 'downloading':
        return 'Güncelleme indiriliyor';
      case 'ready-to-restart':
        return 'Hazır — yeniden başlat';
      case 'installing':
        return 'Güncelleme kuruluyor';
      default:
        return 'An update is available';
    }
  };

  const renderStatusDescription = () => {
    switch (status.type) {
      case 'up-to-date':
        return `Current ${appName} version v${currentVersion} is up to date`;
      case 'checking':
        return `Looking for a newer ${appName} version`;
      case 'not-checked':
      case 'check-failed':
        return `Current ${appName} version is v${currentVersion}`;
      case 'manual-download':
        return status.reason
          ? `v${status.version} yayımlandı. ${status.reason}`
          : `Version v${status.version} is available. Download it and replace ${appName} in your Applications folder`;
      case 'update-available':
        return `Version v${status.version} is available. Update and restart ${appName} to use the new version`;
      case 'update-download-available':
        return `Version v${status.version} is available. Download and restart ${appName} to use the new version`;
      case 'update-install-available':
        return `Restart ${appName} to use the new version`;
      case 'download-available':
        return `v${status.version} yayımlandı. İndirilip doğrulandıktan sonra yeniden başlatınca kurulur.`;
      case 'downloading':
        return `v${status.version} — İndiriliyor %${clampPercent(status.percent)}`;
      case 'ready-to-restart':
        return `v${status.version} indirildi ve doğrulandı. ${appName} yeniden başlatınca kurulur.`;
      case 'installing':
        return `${appName} kapanıp yeni sürümle yeniden açılacak.`;
    }
  };

  const getStatusSeverity = () => {
    switch (status.type) {
      case 'up-to-date':
        return 'success';
      case 'not-checked':
      case 'checking':
        return 'neutral';
      case 'check-failed':
        return 'warning';
      case 'manual-download':
        return 'warning';
      case 'update-available':
        return 'warning';
      case 'update-download-available':
        return 'warning';
      case 'update-install-available':
        return 'warning';
      case 'download-available':
        return 'warning';
      case 'ready-to-restart':
        return 'warning';
      case 'downloading':
      case 'installing':
        return 'neutral';
    }
  };

  return (
    <Box surface="sunken" borderRadius="md" padding="2" px="3" className="min-w-0">
      <div className={styles.row}>
        <StatusIcon size="lg" severity={getStatusSeverity()} />
        <div className={styles.rowBody}>
          <div className={styles.rowTitle}>
            {renderStatusLabel()}
            {error && (
              <Pill variant="error" className={styles.errorPill} title={error.message}>
                {error.message}
              </Pill>
            )}
          </div>
          <div className={styles.rowDescription}>{renderStatusDescription()}</div>
        </div>
        <div className={styles.rowControls}>
          {renderReleaseLink()}
          {renderActionButton()}
        </div>
      </div>
    </Box>
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function DownloadButton({
  onClick,
  isDownloading,
  progress,
}: {
  onClick: () => void;
  isDownloading: boolean;
  progress: number;
}) {
  const renderButtonContent = () => {
    if (isDownloading) {
      return (
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      );
    }

    return 'Download';
  };

  return (
    <Button variant="secondary" size="xs" disabled={isDownloading} onClick={onClick}>
      {renderButtonContent()}
    </Button>
  );
}
