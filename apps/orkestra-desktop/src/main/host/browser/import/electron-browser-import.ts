// Çerez içe aktarma servisinin Electron'a bağlanması: hedef profilin kalıcı bölümü (partition),
// sistem anahtar zinciri okuyucusu ve Tam Disk Erişimi ayar sayfası.
import { shell } from 'electron';
import {
  browserProfilePartition,
  DEFAULT_BROWSER_PROFILES,
  isNamedBrowserProfileId,
} from '@core/primitives/browser/api';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import { configureBrowserProfileSession } from '@main/host/browser/browser-profile-session';
import { log } from '@main/lib/logger';
import { createBrowserImportService, type BrowserImportService } from './browser-import-service';
import { createSystemSafeStorageSecretReader } from './chromium-keys';
import { createSourcePathContext } from './sources';

const FULL_DISK_ACCESS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

let service: BrowserImportService | undefined;

export function getBrowserImportService(): BrowserImportService {
  service ??= createBrowserImportService({
    context: createSourcePathContext({}),
    secrets: createSystemSafeStorageSecretReader(),
    async getTargetSession(profileId) {
      if (!isNamedBrowserProfileId(profileId)) return undefined;
      const settings = await getAppSettingsService().get('browser');
      const profiles = settings.profiles ?? DEFAULT_BROWSER_PROFILES;
      if (!profiles.some((profile) => profile.id === profileId)) return undefined;
      return configureBrowserProfileSession(browserProfilePartition(profileId));
    },
    log: (message, meta) => log.info(message, meta),
  });
  return service;
}

export async function openFullDiskAccessSettings(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await shell.openExternal(FULL_DISK_ACCESS_SETTINGS_URL);
    return true;
  } catch {
    return false;
  }
}
