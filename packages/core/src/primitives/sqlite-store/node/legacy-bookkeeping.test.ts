import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger, type Logger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BundledMigration, SqliteConnection } from '../api';
import { listBackups } from './backup';
import { betterSqlite3Driver } from './better-sqlite3-driver';
import { drizzleV0Interop } from './drizzle-v0-interop';
import { migrateDurable } from './durable';
import { defineDurableSqliteStore } from './store';

// v1.2.6 ve öncesi, uygulanan migration'ları `__emdash_migrations` tablosuna yazıyordu;
// v1.2.7 tabloyu `__orkestra_migrations` olarak yeniden adlandırdı.
const LEGACY_TABLE = '__emdash_migrations';
const CURRENT_TABLE = '__orkestra_migrations';

const migrations: BundledMigration[] = [
  {
    idx: 0,
    tag: '0000_items',
    when: 1,
    hash: 'hash-0000',
    sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
  },
  {
    idx: 1,
    tag: '0001_applications',
    when: 2,
    hash: 'hash-0001',
    sql: `
      CREATE TABLE IF NOT EXISTS applications (tag TEXT NOT NULL);
      INSERT INTO applications (tag) VALUES ('0001');
    `,
  },
  {
    idx: 2,
    tag: '0002_items_note',
    when: 3,
    hash: 'hash-0002',
    sql: `
      ALTER TABLE items ADD COLUMN note TEXT;
      INSERT INTO applications (tag) VALUES ('0002');
    `,
  },
];

type BookkeepingRow = { tag: string; hash: string; applied_at: number };

const directories: string[] = [];

function tempDatabasePath(): string {
  const directory = join(tmpdir(), `sqlite-store-legacy-bookkeeping-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  return join(directory, 'store.db');
}

function createBookkeepingTable(connection: SqliteConnection, table: string): void {
  connection.exec(`
    CREATE TABLE ${table} (
      tag TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
}

function recordApplied(connection: SqliteConnection, table: string, row: BookkeepingRow): void {
  connection.run(`INSERT INTO ${table} (tag, hash, applied_at) VALUES (?, ?, ?)`, [
    row.tag,
    row.hash,
    row.applied_at,
  ]);
}

function legacyRow(migration: BundledMigration): BookkeepingRow {
  return { tag: migration.tag, hash: migration.hash, applied_at: 1_000 + migration.idx };
}

/** v1.2.6 ve öncesinin diske bıraktığı durum: eski adlı defter tablosu ve user_version = 1. */
function createLegacyDatabase(path: string, applied: readonly BundledMigration[]): void {
  const connection = betterSqlite3Driver.open(path);
  try {
    createBookkeepingTable(connection, LEGACY_TABLE);
    for (const migration of applied) {
      connection.exec(migration.sql);
      recordApplied(connection, LEGACY_TABLE, legacyRow(migration));
    }
    connection.run(`INSERT INTO items (id, value) VALUES (1, 'kept')`);
    connection.exec('PRAGMA user_version = 1');
  } finally {
    connection.close();
  }
}

function tableExists(connection: SqliteConnection, table: string): boolean {
  return (
    connection.get(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`, [
      table,
    ]) !== undefined
  );
}

function readBookkeeping(connection: SqliteConnection, table = CURRENT_TABLE): BookkeepingRow[] {
  return connection.all<BookkeepingRow>(`SELECT tag, hash, applied_at FROM ${table} ORDER BY tag`);
}

function readApplications(connection: SqliteConnection): string[] {
  return connection
    .all<{ tag: string }>('SELECT tag FROM applications ORDER BY rowid')
    .map(({ tag }) => tag);
}

function readUserVersion(connection: SqliteConnection): number | undefined {
  return connection.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
}

function defineStore(name: string) {
  return defineDurableSqliteStore({
    name,
    driver: betterSqlite3Driver,
    migrations,
    backup: { retain: 2 },
  });
}

function spyLogger() {
  const info = vi.fn();
  const logger: Logger = { ...noopLogger, info, child: () => logger };
  return { logger, info };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable SQLite bookkeeping from before the Orkestra rename', () => {
  it('adopts __emdash_migrations without reapplying migrations and keeps the store usable', () => {
    const path = tempDatabasePath();
    createLegacyDatabase(path, migrations);
    const store = defineStore('legacy-adoption-test');

    const first = store.open(path);
    try {
      expect(readBookkeeping(first.connection)).toEqual(migrations.map(legacyRow));
      expect(tableExists(first.connection, LEGACY_TABLE)).toBe(false);
      expect(readUserVersion(first.connection)).toBe(1);
      expect(readApplications(first.connection)).toEqual(['0001', '0002']);
      expect(first.connection.all('SELECT id, value, note FROM items')).toEqual([
        { id: 1, value: 'kept', note: null },
      ]);
      first.connection.run(`INSERT INTO items (id, value, note) VALUES (2, 'new', 'after')`);
    } finally {
      first.close();
    }

    // Defter onarımından önce yedek alınır; yedekte eski tablo hâlâ durur.
    const backups = listBackups(path);
    expect(backups).toHaveLength(1);
    const backup = betterSqlite3Driver.open(backups[0]);
    try {
      expect(readBookkeeping(backup, LEGACY_TABLE)).toEqual(migrations.map(legacyRow));
      expect(tableExists(backup, CURRENT_TABLE)).toBe(false);
    } finally {
      backup.close();
    }

    const second = store.open(path);
    try {
      expect(readBookkeeping(second.connection)).toEqual(migrations.map(legacyRow));
      expect(readApplications(second.connection)).toEqual(['0001', '0002']);
      expect(
        second.connection.get<{ count: number }>('SELECT count(*) AS count FROM items')
      ).toEqual({ count: 2 });
    } finally {
      second.close();
    }
    expect(listBackups(path)).toHaveLength(1);
  });

  it('applies only the migrations missing from the adopted legacy history', () => {
    const path = tempDatabasePath();
    createLegacyDatabase(path, migrations.slice(0, 2));
    const connection = betterSqlite3Driver.open(path);

    try {
      const result = migrateDurable(
        connection,
        {
          name: 'legacy-pending-test',
          driver: betterSqlite3Driver,
          migrations,
          backup: { retain: 2 },
        },
        noopLogger,
        { databasePath: path }
      );

      expect(result).toEqual({ appliedCount: 1 });
      const bookkeeping = readBookkeeping(connection);
      expect(bookkeeping.slice(0, 2)).toEqual(migrations.slice(0, 2).map(legacyRow));
      expect(bookkeeping.map(({ tag }) => tag)).toEqual(migrations.map(({ tag }) => tag));
      expect(readApplications(connection)).toEqual(['0001', '0002']);
      expect(tableExists(connection, LEGACY_TABLE)).toBe(false);
    } finally {
      connection.close();
    }
    // Onarımdan önce tek yedek; bekleyen migration için ikinci bir yedek alınmaz.
    expect(listBackups(path)).toHaveLength(1);
  });

  it('merges a leftover legacy table into existing bookkeeping, keeping current rows', () => {
    const path = tempDatabasePath();
    const setup = betterSqlite3Driver.open(path);
    try {
      for (const migration of migrations) setup.exec(migration.sql);
      createBookkeepingTable(setup, CURRENT_TABLE);
      recordApplied(setup, CURRENT_TABLE, {
        tag: '0000_items',
        hash: 'hash-0000',
        applied_at: 5_000,
      });
      recordApplied(setup, CURRENT_TABLE, {
        tag: '0001_applications',
        hash: 'hash-0001',
        applied_at: 5_001,
      });
      createBookkeepingTable(setup, LEGACY_TABLE);
      recordApplied(setup, LEGACY_TABLE, {
        tag: '0000_items',
        hash: 'stale-hash',
        applied_at: 1_000,
      });
      recordApplied(setup, LEGACY_TABLE, legacyRow(migrations[2]));
      setup.exec('PRAGMA user_version = 1');
    } finally {
      setup.close();
    }

    const handle = defineStore('legacy-merge-test').open(path);
    try {
      expect(readBookkeeping(handle.connection)).toEqual([
        { tag: '0000_items', hash: 'hash-0000', applied_at: 5_000 },
        { tag: '0001_applications', hash: 'hash-0001', applied_at: 5_001 },
        legacyRow(migrations[2]),
      ]);
      expect(tableExists(handle.connection, LEGACY_TABLE)).toBe(false);
      expect(readApplications(handle.connection)).toEqual(['0001', '0002']);
    } finally {
      handle.close();
    }
  });

  it('adopts legacy bookkeeping even when a view in the schema no longer resolves', () => {
    const path = tempDatabasePath();
    createLegacyDatabase(path, migrations);
    const setup = betterSqlite3Driver.open(path);
    try {
      // ALTER TABLE ... RENAME bu şemada "error in view" ile başarısız olur.
      setup.exec(`
        CREATE TABLE retired (id INTEGER PRIMARY KEY);
        CREATE VIEW retired_ids AS SELECT id FROM retired;
        DROP TABLE retired;
      `);
    } finally {
      setup.close();
    }

    const handle = defineStore('legacy-broken-view-test').open(path);
    try {
      expect(readBookkeeping(handle.connection)).toEqual(migrations.map(legacyRow));
      expect(tableExists(handle.connection, LEGACY_TABLE)).toBe(false);
      expect(readApplications(handle.connection)).toEqual(['0001', '0002']);
    } finally {
      handle.close();
    }
  });

  it('rolls back the legacy adoption when the bootstrap transaction fails', () => {
    const path = tempDatabasePath();
    createLegacyDatabase(path, migrations);
    const failing = defineDurableSqliteStore({
      name: 'legacy-rollback-test',
      driver: betterSqlite3Driver,
      migrations,
      interop: {
        backfill: () => {
          throw new Error('backfill failed');
        },
      },
    });

    expect(() => failing.open(path)).toThrow('backfill failed');

    const inspect = betterSqlite3Driver.open(path);
    try {
      expect(readBookkeeping(inspect, LEGACY_TABLE)).toEqual(migrations.map(legacyRow));
      expect(tableExists(inspect, CURRENT_TABLE)).toBe(false);
      expect(readUserVersion(inspect)).toBe(1);
    } finally {
      inspect.close();
    }

    const recovered = defineStore('legacy-rollback-recovery-test').open(path);
    try {
      expect(readBookkeeping(recovered.connection)).toEqual(migrations.map(legacyRow));
    } finally {
      recovered.close();
    }
  });
});

describe('durable SQLite bookkeeping integrity checks', () => {
  it('bootstraps a fresh database without legacy artifacts or backups', () => {
    const path = tempDatabasePath();
    const handle = defineStore('fresh-bookkeeping-test').open(path);

    try {
      expect(readBookkeeping(handle.connection).map(({ tag }) => tag)).toEqual(
        migrations.map(({ tag }) => tag)
      );
      expect(tableExists(handle.connection, LEGACY_TABLE)).toBe(false);
      expect(readApplications(handle.connection)).toEqual(['0001', '0002']);
    } finally {
      handle.close();
    }
    expect(listBackups(path)).toEqual([]);
  });

  it('leaves a database with current bookkeeping untouched', () => {
    const path = tempDatabasePath();
    const store = defineStore('current-bookkeeping-test');
    store.open(path).close();

    const connection = betterSqlite3Driver.open(path);
    const { logger, info } = spyLogger();
    try {
      const before = readBookkeeping(connection);
      expect(
        migrateDurable(
          connection,
          {
            name: 'current-bookkeeping-test',
            driver: betterSqlite3Driver,
            migrations,
            backup: { retain: 2 },
          },
          logger,
          { databasePath: path }
        )
      ).toEqual({ appliedCount: 0 });
      expect(readBookkeeping(connection)).toEqual(before);
      expect(tableExists(connection, LEGACY_TABLE)).toBe(false);
      expect(info).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
    expect(listBackups(path)).toEqual([]);
  });

  it('recreates missing bookkeeping instead of trusting user_version alone', () => {
    const path = tempDatabasePath();
    const setup = betterSqlite3Driver.open(path);
    setup.exec('PRAGMA user_version = 1');
    setup.close();

    const handle = defineStore('missing-bookkeeping-test').open(path);
    try {
      expect(readBookkeeping(handle.connection).map(({ tag }) => tag)).toEqual(
        migrations.map(({ tag }) => tag)
      );
      expect(readApplications(handle.connection)).toEqual(['0001', '0002']);
    } finally {
      handle.close();
    }
  });

  it('runs interop backfill when it rebuilds missing bookkeeping', () => {
    const path = tempDatabasePath();
    const setup = betterSqlite3Driver.open(path);
    try {
      setup.exec(`
        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hash TEXT NOT NULL,
          created_at NUMERIC
        )
      `);
      for (const migration of migrations.slice(0, 2)) {
        setup.exec(migration.sql);
        setup.run('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)', [
          migration.hash,
          migration.when,
        ]);
      }
      setup.exec('PRAGMA user_version = 1');
    } finally {
      setup.close();
    }
    const store = defineDurableSqliteStore({
      name: 'missing-bookkeeping-interop-test',
      driver: betterSqlite3Driver,
      migrations,
      interop: drizzleV0Interop,
    });

    const handle = store.open(path);
    try {
      expect(readBookkeeping(handle.connection).map(({ tag }) => tag)).toEqual(
        migrations.map(({ tag }) => tag)
      );
      expect(readApplications(handle.connection)).toEqual(['0001', '0002']);
    } finally {
      handle.close();
    }
  });
});
