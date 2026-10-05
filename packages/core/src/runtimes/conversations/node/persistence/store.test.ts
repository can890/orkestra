import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '@orkestra/shared/testing';
import { describe, expect, it } from 'vitest';
import { betterSqlite3Driver } from '#primitives/sqlite-store/node';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { ConversationsRuntime } from '../runtime';
import { migrations } from './migrations/migrations.generated';
import { conversationsStore } from './store';

/**
 * v1.2.6 ve öncesinin bıraktığı conversations.db: defter `__emdash_migrations` tablosunda,
 * user_version = 1 ve PTY sohbeti eski `emdash-chosen` kimlik rejimiyle kayıtlı.
 */
function createPreRenameDatabase(dbFile: string): void {
  const connection = betterSqlite3Driver.open(dbFile);
  try {
    connection.exec(`
      CREATE TABLE __emdash_migrations (
        tag TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    for (const migration of migrations) {
      for (const statement of migration.sql.split('--> statement-breakpoint')) {
        if (statement.trim()) connection.exec(statement);
      }
      connection.run('INSERT INTO __emdash_migrations (tag, hash, applied_at) VALUES (?, ?, ?)', [
        migration.tag,
        migration.hash,
        1_000,
      ]);
    }
    connection.run(
      `INSERT INTO conversation_records (
         id, provider, type, cwd, workspace_path, created_at, title, config, provider_link,
         last_session_activity_at, last_spawned_at, last_resume_outcome, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'conv-legacy',
        'claude-code',
        'pty',
        '/work/repo',
        '/work/repo',
        1_000,
        'Legacy chat',
        JSON.stringify({ version: '1', value: { model: 'sonnet' } }),
        JSON.stringify({
          version: '1',
          providerSessionId: 'session-1',
          idRegime: 'emdash-chosen',
          observedAt: 1_500,
        }),
        2_000,
        1_800,
        'loaded',
        2_500,
      ]
    );
    connection.exec('PRAGMA user_version = 1');
  } finally {
    connection.close();
  }
}

describe('conversations store upgrades', () => {
  it('boots a conversations.db written before the Orkestra rename and keeps its records', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orkestra-conversations-pre-rename-'));
    const dbFile = path.join(dir, 'conversations.db');
    createPreRenameDatabase(dbFile);

    const handle = conversationsStore.open(dbFile);
    // Runtime, worker açılışındaki gibi tüm kayıtları constructor'da yükler.
    const runtime = new ConversationsRuntime({
      handle,
      clock: new ManualClock(10_000),
      attachments: new LocalAttachmentStore(path.join(dir, 'attachments')),
    });
    try {
      const replayed = runtime.create({
        conversationId: 'conv-legacy',
        provider: 'claude-code',
        type: 'pty',
        cwd: '/work/repo',
        workspacePath: '/work/repo',
        idRegime: 'orkestra-chosen',
        createdAt: 1_000,
        title: 'Legacy chat',
        config: { model: 'sonnet' },
      });
      expect(replayed).toEqual({
        success: true,
        data: expect.objectContaining({
          conversationId: 'conv-legacy',
          idRegime: 'orkestra-chosen',
          providerSessionId: 'session-1',
          providerSessionIdObservedAt: 1_500,
          lastResumeOutcome: 'loaded',
          config: { model: 'sonnet' },
        }),
      });

      // Kaydın bir sonraki yazımı güncel değeri diske taşır.
      expect(runtime.rename({ conversationId: 'conv-legacy', title: 'Renamed' }).success).toBe(
        true
      );
      const storedLink = handle.connection.get<{ provider_link: string }>(
        'SELECT provider_link FROM conversation_records WHERE id = ?',
        ['conv-legacy']
      )?.provider_link;
      expect(storedLink && JSON.parse(storedLink)).toMatchObject({ idRegime: 'orkestra-chosen' });
    } finally {
      runtime.dispose();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
