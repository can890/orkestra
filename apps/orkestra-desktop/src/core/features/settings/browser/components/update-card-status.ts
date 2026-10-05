import type { UpdateStatus } from '@orkestra/ui/react/components';
import type { getUpdateStore } from '@core/features/updates/contributions/app-stores';

type UpdateState = ReturnType<typeof getUpdateStore>['state'];

/**
 * Builds are installed by hand, so a newer version opens its release page. "Up to date" is only
 * shown after a check succeeded; a version found earlier stays visible when a later check fails.
 */
export function toUpdateCardStatus(
  state: UpdateState,
  availableVersion: string | undefined,
  actions: { openRelease: () => Promise<void>; install: () => Promise<void> }
): UpdateStatus {
  const manualDownload = (version: string): UpdateStatus => ({
    type: 'manual-download',
    version,
    onOpen: actions.openRelease,
  });
  switch (state.status) {
    case 'available':
    case 'downloading': {
      const version =
        availableVersion ?? (state.status === 'available' ? state.info?.version : undefined);
      return version ? manualDownload(version) : { type: 'check-failed' };
    }
    case 'downloaded':
    case 'installing':
      return { type: 'update-install-available', onInstall: actions.install };
    case 'not-available':
      return { type: 'up-to-date' };
    case 'error':
      return availableVersion ? manualDownload(availableVersion) : { type: 'check-failed' };
    case 'checking':
      return { type: 'checking' };
    case 'idle':
      return { type: 'not-checked' };
  }
}
