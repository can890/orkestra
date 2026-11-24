// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/CookieDatabase.ts
//
// Kaynak tarayıcının çerez veritabanı asla doğrudan açılmaz: dosya (ve varsa -wal/-journal
// yan dosyaları) geçici bir dizine kopyalanır, SQLite yalnızca kopyayı açar. Böylece canlı
// veritabanına hiçbir zaman yazılmaz ve tarayıcının kilitleri etkilenmez.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';

export type CookieSqlite = Database.Database;

const SIDECAR_SUFFIXES = ['-wal', '-journal'] as const;

/**
 * Veritabanını geçici bir kopyaya alır, `read` geri çağrısını kopya üzerinde çalıştırır ve
 * sonunda kopyayı siler. WAL dosyası da kopyalandığı için kapanmamış işlemler kaybolmaz.
 */
export async function withCookieDatabaseSnapshot<T>(
  databasePath: string,
  read: (db: CookieSqlite) => T | Promise<T>,
  options: { tempRoot?: string } = {}
): Promise<T> {
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'orkestra-cookie-import-'));
  try {
    const target = join(directory, basename(databasePath));
    await copyFile(databasePath, target);
    for (const suffix of SIDECAR_SUFFIXES) {
      try {
        await copyFile(`${databasePath}${suffix}`, `${target}${suffix}`);
      } catch {
        // Yan dosya yoksa sorun değil.
      }
    }
    // Kopya bize ait; WAL'ın birleştirilebilmesi için yazılabilir açılır.
    const db = new Database(target, { fileMustExist: true });
    try {
      return await read(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function hasTable(db: CookieSqlite, name: string): boolean {
  return (
    db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(name) !==
    undefined
  );
}
