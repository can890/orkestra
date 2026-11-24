import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isStrictlyInside, realpathOrNull } from './worktree-inspector';

export type FileRetentionResult = { files: number; bytes: number; failed: number };

/**
 * `root` altındaki, `olderThan` (ms) zamanından önce değiştirilmiş dosyaları kaldırır
 * (kuru çalıştırmada yalnızca sayar). Sembolik bağlar hiç izlenmez ve silinmez; her
 * dosyanın gerçek üst klasörü kökün içinde kalmalıdır. `keep` true dönen dosyalar
 * (ör. etkin günlük) korunur. Boşalan alt klasörler kaldırılır; kökün kendisi kalır.
 */
export async function cleanupOldFiles(input: {
  root: string;
  olderThan: number;
  dryRun: boolean;
  keep?: (name: string, relativePath: string) => boolean;
  include?: (name: string) => boolean;
}): Promise<FileRetentionResult> {
  const result: FileRetentionResult = { files: 0, bytes: 0, failed: 0 };
  const root = await realpathOrNull(input.root);
  if (root === null) return result;
  const rootInfo = await fs.lstat(input.root).catch(() => null);
  if (rootInfo === null || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return result;

  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        if (!input.dryRun && full !== root) {
          await fs.rmdir(full).catch(() => undefined);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (input.include && !input.include(entry.name)) continue;
      const relative = path.relative(root, full);
      if (input.keep?.(entry.name, relative)) continue;
      const info = await fs.lstat(full).catch(() => null);
      if (info === null || !info.isFile() || info.mtimeMs >= input.olderThan) continue;
      // Kaçış denetimi: dosyanın gerçek üst klasörü kökün içinde olmalı.
      const realParent = await realpathOrNull(path.dirname(full));
      if (realParent === null || (realParent !== root && !isStrictlyInside(root, realParent))) {
        continue;
      }
      if (input.dryRun) {
        result.files++;
        result.bytes += info.blocks * 512 || info.size;
        continue;
      }
      try {
        await fs.unlink(full);
        result.files++;
        result.bytes += info.blocks * 512 || info.size;
      } catch {
        result.failed++;
      }
    }
  };
  await walk(root);
  return result;
}

/**
 * Hızlı checkout önbelleği: depo kovaları (`<önbellek>/<anahtar>`) son kullanımdan bu
 * yana `olderThan`'dan eskiyse kaldırılır. Önce yeniden adlandırılır; böylece hiçbir
 * klon yarı silinmiş bir checkout'u kopyalamaz.
 */
export async function cleanupCheckoutCache(input: {
  cacheDir: string;
  olderThan: number;
  dryRun: boolean;
  measure: (target: string) => Promise<number | null>;
}): Promise<FileRetentionResult> {
  const result: FileRetentionResult = { files: 0, bytes: 0, failed: 0 };
  const info = await fs.lstat(input.cacheDir).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return result;
  const root = await realpathOrNull(input.cacheDir);
  if (root === null) return result;
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const bucket = path.join(root, name);
    const stat = await fs.lstat(bucket).catch(() => null);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (stat.mtimeMs >= input.olderThan) continue;
    const bytes = (await input.measure(bucket)) ?? 0;
    if (input.dryRun) {
      result.files++;
      result.bytes += bytes;
      continue;
    }
    try {
      const trashed = `${bucket}.trash-${randomUUID()}`;
      await fs.rename(bucket, trashed);
      await fs.rm(trashed, { recursive: true, force: true });
      result.files++;
      result.bytes += bytes;
    } catch {
      result.failed++;
    }
  }
  return result;
}
