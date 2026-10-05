import type { Logger } from '@orkestra/shared/logger';
import {
  computePendingMigrations,
  validateMigrationManifest,
  type AppliedMigration,
  type DurableStoreConfig,
  type SqliteConnection,
} from '../api';
import { createBackup } from './backup';
import { LEGACY_STORE_TABLES, STORE_TABLE } from './constants';
import { tableExists } from './sqlite-schema';
import { inTransaction } from './transaction';

const RUNNER_SCHEMA_VERSION = 1;

type BookkeepingState = {
  runnerVersion: number;
  hasStoreTable: boolean;
  hasLegacyTable: boolean;
};

function readRunnerVersion(connection: SqliteConnection): number {
  return connection.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
}

function readBookkeepingState(connection: SqliteConnection): BookkeepingState {
  const runnerVersion = readRunnerVersion(connection);
  if (runnerVersion > RUNNER_SCHEMA_VERSION) {
    throw new Error(
      `SQLite store runner schema ${runnerVersion} is newer than supported version ${RUNNER_SCHEMA_VERSION}`
    );
  }
  return {
    runnerVersion,
    hasStoreTable: tableExists(connection, STORE_TABLE),
    hasLegacyTable: LEGACY_STORE_TABLES.some((table) => tableExists(connection, table)),
  };
}

/**
 * user_version tek başına defterin var olduğunu kanıtlamaz: tablo yeniden adlandırılmadan
 * önce yazılan store'larda runner sürümü 1'dir ama yalnızca eski adlı tablo bulunur.
 */
function needsBootstrap(state: BookkeepingState): boolean {
  return (
    state.runnerVersion < RUNNER_SCHEMA_VERSION || !state.hasStoreTable || state.hasLegacyTable
  );
}

function hasUserObjects(connection: SqliteConnection): boolean {
  return (
    connection.get(
      `SELECT 1 AS present
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       LIMIT 1`
    ) !== undefined
  );
}

function ensureBookkeeping<TDb, TNative>(
  connection: SqliteConnection,
  config: DurableStoreConfig<TDb, TNative>,
  state: BookkeepingState,
  logger: Logger
): void {
  if (!needsBootstrap(state)) return;

  const adoptedLegacyTables = inTransaction(connection, () => {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (
        tag TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    // Yazma kilidi altında yeniden okunur; başka bir açılış tabloyu çoktan taşımış olabilir.
    const legacyTables = LEGACY_STORE_TABLES.filter((table) => tableExists(connection, table));
    for (const legacyTable of legacyTables) {
      // Aynı tag iki tabloda da varsa güncel satır kalır. RENAME yerine kopyalanır: ALTER
      // TABLE ... RENAME, şemadaki herhangi bir bozuk view/trigger yüzünden başarısız olur.
      connection.exec(`
        INSERT OR IGNORE INTO ${STORE_TABLE} (tag, hash, applied_at)
        SELECT tag, hash, applied_at FROM ${legacyTable}
      `);
      connection.exec(`DROP TABLE ${legacyTable}`);
    }
    config.interop?.backfill?.(connection, config.migrations);
    connection.exec(`PRAGMA user_version = ${RUNNER_SCHEMA_VERSION}`);
    return legacyTables;
  });
  logger.info('Bootstrapped durable SQLite store bookkeeping', {
    name: config.name,
    version: RUNNER_SCHEMA_VERSION,
    previousVersion: state.runnerVersion,
    adoptedLegacyTables,
  });
}

function readApplied(connection: SqliteConnection): AppliedMigration[] {
  return connection.all<AppliedMigration>(`SELECT tag, hash FROM ${STORE_TABLE}`);
}

function executeMigrationStatements(connection: SqliteConnection, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) connection.exec(trimmed);
  }
}

export type MigrateDurableOptions = {
  databasePath?: string;
  targetExclusiveIdx?: number;
};

export type MigrateDurableResult = {
  appliedCount: number;
};

export function migrateDurable<TDb, TNative>(
  connection: SqliteConnection,
  config: DurableStoreConfig<TDb, TNative>,
  logger: Logger,
  options: MigrateDurableOptions = {}
): MigrateDurableResult {
  validateMigrationManifest(config.migrations);
  const bookkeeping = readBookkeepingState(connection);
  const hadUserObjects = hasUserObjects(connection);
  let backupCreated = false;

  if (needsBootstrap(bookkeeping) && hadUserObjects && options.databasePath && config.backup) {
    createBackup(connection, options.databasePath, config.backup.retain, logger);
    backupCreated = true;
  }

  ensureBookkeeping(connection, config, bookkeeping, logger);

  const { targetExclusiveIdx } = options;
  const eligibleMigrations =
    targetExclusiveIdx === undefined
      ? config.migrations
      : config.migrations.filter(({ idx }) => idx < targetExclusiveIdx);
  const pending = computePendingMigrations(readApplied(connection), eligibleMigrations);
  if (pending.length === 0) return { appliedCount: 0 };

  if (!backupCreated && hadUserObjects && options.databasePath && config.backup) {
    createBackup(connection, options.databasePath, config.backup.retain, logger);
  }

  connection.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const migration of pending) {
      inTransaction(connection, () => {
        executeMigrationStatements(connection, migration.sql);
        connection.run(
          `INSERT INTO ${STORE_TABLE} (tag, hash, applied_at)
           VALUES (?, ?, ?)`,
          [migration.tag, migration.hash, Date.now()]
        );
        config.interop?.onApplied?.(connection, migration);
      });
      logger.info('Applied durable SQLite store migration', {
        name: config.name,
        tag: migration.tag,
      });
    }

    const violations = connection.all<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error(
        `SQLite migrations left foreign-key violations: ${JSON.stringify(violations.slice(0, 5))}`
      );
    }
  } finally {
    connection.exec('PRAGMA foreign_keys = ON');
  }
  return { appliedCount: pending.length };
}
