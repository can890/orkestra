import type { UpdateStatus } from '@orkestra/ui/react/components';
import type { getUpdateStore } from '@core/features/updates/contributions/app-stores';

type UpdateStore = ReturnType<typeof getUpdateStore>;
type UpdateState = UpdateStore['state'];

export type UpdateCardInfo = Pick<UpdateStore, 'availableVersion' | 'installMode' | 'manualReason'>;

export type UpdateCardActions = {
  openRelease: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
};

/**
 * Maps the update store onto the shared card. In-app installs download, verify and restart;
 * manual installs open the release page. "Up to date" is only shown after a check succeeded,
 * and a version found earlier stays visible when a later check or download fails.
 */
export function toUpdateCardStatus(
  state: UpdateState,
  info: UpdateCardInfo,
  actions: UpdateCardActions
): UpdateStatus {
  const inApp = info.installMode === 'in-app';
  const manualDownload = (version: string): UpdateStatus => ({
    type: 'manual-download',
    version,
    onOpen: actions.openRelease,
    reason: info.manualReason,
  });
  const offerDownload = (version: string, retry: boolean): UpdateStatus =>
    inApp
      ? {
          type: 'download-available',
          version,
          onDownload: actions.download,
          onOpenRelease: actions.openRelease,
          retry,
        }
      : manualDownload(version);

  switch (state.status) {
    case 'available': {
      const version = info.availableVersion ?? state.info?.version;
      return version ? offerDownload(version, false) : { type: 'check-failed' };
    }
    case 'downloading': {
      const version = info.availableVersion;
      if (!version) return { type: 'checking' };
      return {
        type: 'downloading',
        version,
        percent: state.progress?.percent ?? 0,
        onOpenRelease: actions.openRelease,
      };
    }
    case 'downloaded':
      return info.availableVersion
        ? {
            type: 'ready-to-restart',
            version: info.availableVersion,
            onInstall: actions.install,
            onOpenRelease: actions.openRelease,
          }
        : { type: 'update-install-available', onInstall: actions.install };
    case 'installing':
      return { type: 'installing' };
    case 'not-available':
      return { type: 'up-to-date' };
    case 'error':
      return info.availableVersion
        ? offerDownload(info.availableVersion, true)
        : { type: 'check-failed' };
    case 'checking':
      return { type: 'checking' };
    case 'idle':
      return { type: 'not-checked' };
  }
}
