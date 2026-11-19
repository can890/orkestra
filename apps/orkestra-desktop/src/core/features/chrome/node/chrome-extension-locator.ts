import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Paketle gelen Chrome uzantısı klasörünü çözer. Yol yalnızca ana sürecin kendi bildiği sabit
// konumlardan gelir (paketliyse `resources/chrome-extension`, değilse depodaki
// `apps/chrome-extension`); renderer'dan ya da ajandan hiçbir yol alınmaz.

export interface ChromeExtensionInfo {
  path: string | null;
  available: boolean;
  version: string | null;
}

export interface ChromeExtensionLocationDeps {
  isPackaged: boolean;
  /** Paketliyse `process.resourcesPath`. */
  resourcesPath: string;
  /** Paketsizken uygulama dizini (`apps/orkestra-desktop`); uzantı kardeş klasördedir. */
  appPath: string;
}

export const CHROME_EXTENSION_DIR_NAME = 'chrome-extension';

export function resolveChromeExtensionDir(deps: ChromeExtensionLocationDeps): string {
  return deps.isPackaged
    ? join(deps.resourcesPath, CHROME_EXTENSION_DIR_NAME)
    : resolve(deps.appPath, '..', CHROME_EXTENSION_DIR_NAME);
}

export async function getChromeExtensionInfo(
  deps: ChromeExtensionLocationDeps
): Promise<ChromeExtensionInfo> {
  const dir = resolveChromeExtensionDir(deps);
  try {
    if (!(await stat(dir)).isDirectory()) return { path: dir, available: false, version: null };
    const manifest: unknown = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const version =
      manifest && typeof manifest === 'object' && 'version' in manifest
        ? (manifest as { version: unknown }).version
        : null;
    return {
      path: dir,
      available: true,
      version: typeof version === 'string' ? version : null,
    };
  } catch {
    return { path: dir, available: false, version: null };
  }
}

export interface ChromeExtensionOperationsDeps {
  location: ChromeExtensionLocationDeps;
  /** `shell.showItemInFolder` (testte sahte). */
  showItemInFolder: (path: string) => void;
  /** Süreç çalıştırıcı: yalnızca `execFile` anlamı (shell yok); hata verirse reddeder. */
  runFile: (file: string, args: readonly string[]) => Promise<void>;
  platform: NodeJS.Platform;
}

export function createChromeExtensionOperations(deps: ChromeExtensionOperationsDeps) {
  return {
    getExtensionInfo: () => getChromeExtensionInfo(deps.location),
    revealExtensionFolder: async (): Promise<{ revealed: boolean }> => {
      const info = await getChromeExtensionInfo(deps.location);
      if (!info.available || !info.path) return { revealed: false };
      try {
        deps.showItemInFolder(info.path);
        return { revealed: true };
      } catch {
        return { revealed: false };
      }
    },
    openChromeExtensionsPage: async (): Promise<{ opened: boolean }> => {
      if (deps.platform !== 'darwin') return { opened: false };
      try {
        // Sabit argümanlar: kullanıcı ya da ajan verisi komuta girmez.
        await deps.runFile('open', ['-a', 'Google Chrome', 'chrome://extensions']);
        return { opened: true };
      } catch {
        return { opened: false };
      }
    },
  };
}

export type ChromeExtensionOperations = ReturnType<typeof createChromeExtensionOperations>;
