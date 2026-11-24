// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/vcs/CheckoutCloner.ts
import { execFile } from 'node:child_process';

/**
 * Bir dosyayı ya da tüm bir klasörü tek çağrıda copy-on-write kopyalar; veri blokları
 * kopyalardan biri değişene kadar paylaşılır. Hedef var olmamalıdır. Her çift için
 * başarı/başarısızlık döner; çağıran taraf herhangi bir başarısızlıkta normal checkout'a döner.
 */
export type CheckoutCloner = (
  pairs: ReadonlyArray<{ readonly source: string; readonly destination: string }>
) => Promise<boolean>;

/**
 * macOS `clonefile(2)` — bir klasör hiyerarşisini çekirdekte tek seferde klonlar.
 * Yerel bağımlılık eklemeden çağırmak için sistemde her zaman bulunan `osascript`
 * JavaScript köprüsünün `ObjC.bindFunction` olanağı kullanılır (tek süreç, ~100 ms).
 * CLONE_NOFOLLOW (0x0001): bir symlink'in hedefini değil kendisini klonla.
 */
const CLONEFILE_SCRIPT = [
  "ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'unsigned int']]);",
  'function run(argv) {',
  '  var out = [];',
  '  for (var i = 0; i + 1 < argv.length; i += 2) {',
  '    out.push(String($.clonefile(argv[i], argv[i + 1], 1)));',
  '  }',
  "  return out.join(' ');",
  '}',
].join('\n');

const PAIRS_PER_PROCESS = 256;

function runOsascript(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', CLONEFILE_SCRIPT, ...args],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });
}

/** macOS'ta çekirdek `clonefile` tabanlı klonlayıcı; başka platformlarda undefined. */
export function createPlatformCheckoutCloner(
  platform: NodeJS.Platform = process.platform
): CheckoutCloner | undefined {
  if (platform !== 'darwin') return undefined;
  return async (pairs) => {
    for (let start = 0; start < pairs.length; start += PAIRS_PER_PROCESS) {
      const batch = pairs.slice(start, start + PAIRS_PER_PROCESS);
      const stdout = await runOsascript(batch.flatMap((pair) => [pair.source, pair.destination]));
      if (stdout === null) return false;
      const codes = stdout.trim().split(/\s+/u);
      if (codes.length !== batch.length || codes.some((code) => code !== '0')) return false;
    }
    return true;
  };
}
