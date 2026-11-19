import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PluginPathError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Eklenti kökü içinde göreli bir yolu çözer. Mutlak yol, NUL, `..` ile çıkış ve symlink ile
 * köke dışarıdan ulaşma `PluginPathError` fırlatır. Hedef yoksa `null` döner.
 */
export async function resolveInside(root: string, rel: string): Promise<string | null> {
  if (rel.includes('\0')) throw new PluginPathError('Yol geçersiz karakter içeriyor.');
  if (isAbsolute(rel)) throw new PluginPathError(`Mutlak yol reddedildi: ${rel}`);
  const rootReal = await realpath(root);
  const lexical = resolve(rootReal, rel);
  if (!isInside(rootReal, lexical)) {
    throw new PluginPathError(`Yol eklenti kökünün dışına çıkıyor: ${rel}`);
  }
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!isInside(rootReal, real)) {
    throw new PluginPathError(`Symlink eklenti kökünün dışına çıkıyor: ${rel}`);
  }
  return real;
}

/** Boyut sınırıyla bir dosyayı kök içinden okur; yoksa `null`. */
export async function readFileInside(
  root: string,
  rel: string,
  maxBytes: number
): Promise<string | null> {
  const path = await resolveInside(root, rel);
  if (!path) return null;
  const info = await lstat(path);
  if (!info.isFile()) throw new PluginPathError(`Dosya değil: ${rel}`);
  if (info.size > maxBytes) throw new PluginPathError(`Dosya çok büyük (${info.size} bayt): ${rel}`);
  return readFile(path, 'utf8');
}

/** Kök içindeki bir dizinin girdilerini sıralı listeler; kök dışına çıkan girdiler atlanır. */
export async function listDirInside(
  root: string,
  rel: string
): Promise<{ name: string; rel: string; isDir: boolean; isFile: boolean }[] | null> {
  const dir = await resolveInside(root, rel);
  if (!dir) return null;
  const info = await lstat(dir);
  if (!info.isDirectory()) return null;
  const entries = await readdir(dir);
  const out: { name: string; rel: string; isDir: boolean; isFile: boolean }[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue;
    const entryRel = join(rel, name);
    let real: string | null;
    try {
      real = await resolveInside(root, entryRel);
    } catch {
      continue; // dışarı çıkan symlink: listeleme dışı
    }
    if (!real) continue;
    const entryInfo = await lstat(real);
    out.push({
      name,
      rel: entryRel.split(sep).join('/'),
      isDir: entryInfo.isDirectory(),
      isFile: entryInfo.isFile(),
    });
  }
  return out;
}
