import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { createMemorySecureStore, type SecureStore } from './pairing-store';

/**
 * Android'de eklenti değerleri Android Keystore'daki (donanım destekli olabilir) bir RSA anahtarıyla
 * şifreleyip uygulamaya özel SharedPreferences'a yazar. Eklentinin web uygulaması `localStorage`'a
 * düz yazdığı için yerel olmayan ortamda (tarayıcıda geliştirme) bunun yerine bellek deposu
 * kullanılır: sır hiçbir koşulda düz depoya yazılmaz.
 */
export function createDeviceSecureStore(): SecureStore {
  if (!Capacitor.isNativePlatform()) return createMemorySecureStore();
  return {
    async get(key) {
      try {
        const { value } = await SecureStoragePlugin.get({ key });
        return typeof value === 'string' ? value : null;
      } catch {
        // Eklenti, anahtar yoksa istisna fırlatır.
        return null;
      }
    },
    async set(key, value) {
      await SecureStoragePlugin.set({ key, value });
    },
    async remove(key) {
      try {
        await SecureStoragePlugin.remove({ key });
      } catch {
        // Zaten yok.
      }
    },
  };
}
