import type { SqliteConnection } from '../api';

export function tableExists(connection: SqliteConnection, table: string): boolean {
  return (
    connection.get(
      `SELECT 1 AS present
       FROM sqlite_schema
       WHERE type = 'table' AND name = ?
       LIMIT 1`,
      [table]
    ) !== undefined
  );
}
