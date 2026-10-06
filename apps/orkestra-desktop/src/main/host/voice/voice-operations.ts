import { net, safeStorage, shell, systemPreferences } from 'electron';
import type { MicrophoneAccess, VoicePreferences } from '@core/features/voice/api/contract';
import {
  createVoiceService,
  type MicrophonePermissions,
  type VoiceService,
} from '@core/features/voice/node/voice-service';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';

// Ses servisinin ana süreç bileşimi: şifreli sır deposu, Electron net.fetch (sistem proxy
// ayarlarına uyar), kv tablosunda tercihler ve macOS mikrofon izinleri.

type VoiceKvSchema = { preferences: Partial<VoicePreferences> };

const MAC_MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const WINDOWS_MICROPHONE_SETTINGS_URL = 'ms-settings:privacy-microphone';

function microphonePermissions(): MicrophonePermissions {
  const getAccess = (): MicrophoneAccess => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
    return systemPreferences.getMediaAccessStatus('microphone');
  };
  return {
    getAccess,
    async requestAccess() {
      const current = getAccess();
      if (process.platform !== 'darwin' || current !== 'not-determined') return current;
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return granted ? 'granted' : 'denied';
    },
    async openSettings() {
      if (process.platform === 'darwin') await shell.openExternal(MAC_MICROPHONE_SETTINGS_URL);
      else if (process.platform === 'win32') {
        await shell.openExternal(WINDOWS_MICROPHONE_SETTINGS_URL);
      }
    },
  };
}

function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  return safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

export function createVoiceOperations(db: AppDb): VoiceService {
  const kv = new AppDbKeyValueStore<VoiceKvSchema>(db, 'voice', log);
  return createVoiceService({
    secrets: encryptedAppSecretsStore,
    preferences: {
      get: () => kv.get('preferences'),
      set: (preferences) => kv.setOrThrow('preferences', preferences),
    },
    fetch: (url, init) => net.fetch(url, init),
    isSecureStorageAvailable,
    microphone: microphonePermissions(),
    logger: log,
  });
}
