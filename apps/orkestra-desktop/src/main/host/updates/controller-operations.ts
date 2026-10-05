import type { UpdateOperations } from '@core/features/updates/node/wire-controller';
import { updateService } from './update-service';
import { formatUpdaterError } from './utils';

export const updateOperations: UpdateOperations = {
  checkForUpdates: () => updateService.checkForUpdates(),
  downloadUpdate: () => updateService.downloadUpdate(),
  quitAndInstall: () => updateService.quitAndInstall(),
  // Opens the release page for a manual download; the app keeps running.
  openLatestRelease: () => updateService.openReleasePage(),
  getState: () => updateService.getState(),
  fetchReleaseNotes: () => updateService.fetchReleaseNotes(),
  formatError: formatUpdaterError,
};
