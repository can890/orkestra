import { dirname, resolve } from 'node:path';

export type InstallSupport =
  | { supported: true; bundlePath: string }
  | { supported: false; reason: string };

export type InstallLocationInput = {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  /** `app.getPath('exe')`: …/Orkestra.app/Contents/MacOS/Orkestra */
  exePath: string;
  /** Yolun mevcut kullanıcı tarafından yazılabilir olup olmadığını denetler. */
  isWritable(path: string): Promise<boolean>;
};

/** Uygulama içi kurulumun desteklendiği tek hedef; diğer mimariler sürüm sayfasına yönlenir. */
export const SUPPORTED_ARCHES = new Set(['arm64']);

/** Çalıştırılabilir dosya yolundan `.app` paketinin kök dizinini çıkarır. */
export function resolveBundlePath(exePath: string): string | null {
  const bundle = resolve(exePath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/**
 * macOS, karantinadaki bir uygulamayı indirildiği yerden açınca onu salt okunur rastgele bir
 * konumdan (App Translocation) çalıştırır. Bu yolu yerinde değiştirmek anlamsızdır.
 */
export function isTranslocated(bundlePath: string): boolean {
  return bundlePath.includes('/AppTranslocation/');
}

/**
 * Çalışan uygulamanın yerinde değiştirilip değiştirilemeyeceğine karar verir. Desteklenmeyen her
 * durum için kullanıcıya gösterilecek Türkçe bir neden döner; hizmet bu durumda sürüm sayfasını
 * açan elle kurulum akışına geri düşer.
 */
export async function checkInstallLocation(input: InstallLocationInput): Promise<InstallSupport> {
  if (input.platform !== 'darwin') {
    return {
      supported: false,
      reason: 'Uygulama içi güncelleme şimdilik yalnızca macOS’ta kullanılabilir.',
    };
  }
  if (!SUPPORTED_ARCHES.has(input.arch)) {
    return {
      supported: false,
      reason: 'Uygulama içi güncelleme yalnızca Apple Silicon (arm64) sürümünde kullanılabilir.',
    };
  }
  if (!input.isPackaged) {
    return { supported: false, reason: 'Geliştirme sürümünde uygulama içi güncelleme kapalıdır.' };
  }
  const bundlePath = resolveBundlePath(input.exePath);
  if (!bundlePath) {
    return { supported: false, reason: 'Orkestra uygulama paketinin konumu belirlenemedi.' };
  }
  if (isTranslocated(bundlePath)) {
    return {
      supported: false,
      reason:
        'Orkestra macOS’un geçici karantina konumundan çalışıyor. Uygulamayı Applications klasörüne taşıyıp yeniden açın.',
    };
  }
  if (bundlePath.startsWith('/Volumes/')) {
    return {
      supported: false,
      reason:
        'Orkestra bir disk görüntüsünden ya da harici diskten çalışıyor. Uygulamayı Applications klasörüne taşıyın.',
    };
  }
  const parent = dirname(bundlePath);
  const writable = (await input.isWritable(parent)) && (await input.isWritable(bundlePath));
  if (!writable) {
    return {
      supported: false,
      reason: `Orkestra’nın bulunduğu klasöre yazma izni yok (${parent}). Güncellemeyi sürüm sayfasından elle kurun.`,
    };
  }
  return { supported: true, bundlePath };
}
