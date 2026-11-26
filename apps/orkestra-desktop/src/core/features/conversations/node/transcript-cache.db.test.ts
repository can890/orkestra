import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationRegistryTable } from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { kv } from '@core/services/app-db/node/schema';
import { ConversationTranscriptCache } from './transcript-cache';

function createTestDb(): { sqlite: Database.Database; db: AppDb } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT,
      task_id TEXT,
      is_initial_conversation INTEGER,
      agent_status_seen INTEGER DEFAULT 1,
      agent_status TEXT,
      title TEXT NOT NULL,
      provider TEXT,
      type TEXT,
      config TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      cwd TEXT,
      workspace_path TEXT,
      provider_session_id TEXT,
      id_regime TEXT,
      last_session_activity_at TEXT,
      observed_status TEXT,
      last_observed_at TEXT,
      origin TEXT DEFAULT 'registered' NOT NULL,
      location TEXT,
      ssh_connection_id TEXT,
      untracked_at TEXT,
      deletion_tombstone TEXT
    );
    CREATE VIRTUAL TABLE message_search_fts USING fts5(
      conversation_id UNINDEXED,
      project_id UNINDEXED,
      task_id UNINDEXED,
      item_id UNINDEXED,
      role UNINDEXED,
      conversation_title,
      content,
      created_at UNINDEXED
    );
  `);
  const db = drizzle(sqlite, {
    schema: { kv, conversations: conversationRegistryTable },
  }) as unknown as AppDb;
  return { sqlite, db };
}

describe('ConversationTranscriptCache', () => {
  let homeDir: string;
  let sqlite: Database.Database;
  let db: AppDb;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'orkestra-transcript-cache-'));
    ({ sqlite, db } = createTestDb());
  });

  afterEach(async () => {
    sqlite.close();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reads and writes rich ACP turns through SQLite kv cache', async () => {
    const cache = new ConversationTranscriptCache(db, { homeDir });
    const turns = [
      {
        id: 't1',
        seq: 1,
        initiator: 'user' as const,
        items: [
          { kind: 'message' as const, id: 'm1', seq: 1, role: 'user' as const, text: 'Selam' },
          {
            kind: 'message' as const,
            id: 'm2',
            seq: 2,
            role: 'assistant' as const,
            text: 'Merhaba!',
          },
        ],
        outcome: { kind: 'done' as const, reason: 'end_turn' as const },
      },
    ];

    cache.save('conv-1', turns);
    const res = await cache.readInstantTranscript('conv-1');
    expect(res.source).toBe('cache');
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]?.items).toHaveLength(2);

    cache.remove('conv-1');
    const afterRemove = await cache.readInstantTranscript('conv-1');
    expect(afterRemove).toEqual({ turns: [], source: 'empty' });
  });

  it('recovers Codex user images on disk and from legacy cached links', async () => {
    const cache = new ConversationTranscriptCache(db, { homeDir });
    const sessionId = 'codex-image-session';
    const dataUrl = 'data:image/png;base64,aW1hZ2U=';
    const otherImage = 'data:image/png;base64,Y2F0';
    const logs = join(homeDir, '.codex', 'sessions', '2026', '11', '24');
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, `rollout-2026-11-24T12-00-00-${sessionId}.jsonl`),
      [
        { type: 'event_msg', payload: { type: 'user_message', message: 'Look' } },
        ...[dataUrl, otherImage].map((image_url) => ({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [
              { type: 'input_image', image_url },
              { type: 'input_text', text: 'Look' },
            ],
          },
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf8'
    );
    sqlite
      .prepare(
        'INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)'
      )
      .run('codex-images', 'Codex Chat', 'codex', sessionId, 'local');

    for (const source of ['disk', 'cache']) {
      const result = await cache.readInstantTranscript('codex-images');
      expect(result.source).toBe(source);
      expect(result.turns.map(({ items }) => items[0])).toMatchObject([
        { role: 'user', text: 'Look', attachments: [{ dataUrl }] },
        { role: 'user', text: 'Look', attachments: [{ dataUrl: otherImage }] },
      ]);
    }

    cache.save('legacy', [
      {
        id: 't1',
        seq: 1,
        initiator: 'user',
        items: [
          { kind: 'message', id: 'm1', seq: 1, role: 'user', text: `[@image](${dataUrl})Look` },
        ],
      },
    ]);
    const restored = await cache.readInstantTranscript('legacy');
    expect(restored.turns[0]?.items[0]).toMatchObject({
      role: 'user',
      text: 'Look',
      attachments: [{ dataUrl }],
    });
  });

  it('keeps the turns of a replaced session as earlier turns, apart from the new history', async () => {
    const cache = new ConversationTranscriptCache(db, { homeDir });
    const turn = (id: string, text: string) => ({
      id,
      seq: 1,
      initiator: 'user' as const,
      items: [{ kind: 'message' as const, id: `${id}-m`, seq: 1, role: 'user' as const, text }],
    });

    // Nothing cached: nothing to keep.
    cache.preserveAsEarlierTurns('conv-1');
    expect(cache.readEarlierTurns('conv-1')).toEqual([]);

    cache.save('conv-1', [turn('t1', 'ilk oturum')]);
    cache.preserveAsEarlierTurns('conv-1');
    expect(cache.readEarlierTurns('conv-1').map((t) => t.id)).toEqual(['t1']);
    // The current history now belongs to the new session only.
    expect(await cache.readInstantTranscript('conv-1')).toEqual({ turns: [], source: 'empty' });

    // A second replacement appends after the earlier turns.
    cache.save('conv-1', [turn('t2', 'ikinci oturum')]);
    cache.preserveAsEarlierTurns('conv-1');
    expect(cache.readEarlierTurns('conv-1').map((t) => t.id)).toEqual(['t1', 't2']);

    cache.remove('conv-1');
    expect(cache.readEarlierTurns('conv-1')).toEqual([]);
  });

  it('reads local Antigravity and Claude disk transcripts without spawning any CLI', async () => {
    const agyDir = join(
      homeDir,
      '.gemini',
      'antigravity',
      'brain',
      'agy-sid-1',
      '.system_generated',
      'logs'
    );
    await mkdir(agyDir, { recursive: true });
    await writeFile(
      join(agyDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'USER_INPUT',
          id: 'u1',
          content: '<USER_REQUEST>Antigravity test sorusu</USER_REQUEST>',
          created_at: '2026-11-24T12:00:00Z',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          id: 'a1',
          content: 'Antigravity cevabı hazır.',
          created_at: '2026-11-24T12:00:02Z',
        }),
      ].join('\n'),
      'utf8'
    );

    const claudeDir = join(homeDir, '.claude', 'projects', 'demo-proj');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'claude-sid-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'cu1',
          message: { content: 'Claude merhaba' },
          timestamp: '2026-11-24T12:01:00Z',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'ca1',
          message: { content: [{ type: 'text', text: 'Selam, nasıl yardımcı olayım?' }] },
          timestamp: '2026-11-24T12:01:01Z',
        }),
      ].join('\n'),
      'utf8'
    );

    sqlite
      .prepare(
        `INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)`
      )
      .run('conv-agy', 'Agy Chat', 'antigravity', 'agy-sid-1', 'local');
    sqlite
      .prepare(
        `INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)`
      )
      .run('conv-claude', 'Claude Chat', 'claude', 'claude-sid-1', 'local');

    const cache = new ConversationTranscriptCache(db, { homeDir });
    const agyRes = await cache.readInstantTranscript('conv-agy');
    expect(agyRes.source).toBe('disk');
    expect(agyRes.turns).toHaveLength(1);
    expect(agyRes.turns[0]?.items[0]).toMatchObject({
      role: 'user',
      text: 'Antigravity test sorusu',
    });
    expect(agyRes.turns[0]?.items[1]).toMatchObject({
      role: 'assistant',
      text: 'Antigravity cevabı hazır.',
    });

    // Second read hits SQLite kv cache directly
    const agySecond = await cache.readInstantTranscript('conv-agy');
    expect(agySecond.source).toBe('cache');

    // Prewarm populates remaining local conversations
    const warmed = await cache.prewarmLocalConversations();
    expect(warmed).toBe(1);
    const claudeRes = await cache.readInstantTranscript('conv-claude');
    expect(claudeRes.source).toBe('cache');
    expect(claudeRes.turns[0]?.items[0]).toMatchObject({ role: 'user', text: 'Claude merhaba' });
  });

  it('restores Antigravity images from the provider log and an older text-only cache', async () => {
    const sessionId = '14ba23e2-b3db-4308-8d4b-55c72e66baf0';
    const nativeId = 'da11ebc9-7041-4bc2-bd85-aec73e80a64e';
    const stateDir = join(homeDir, '.local', 'state', 'orkestra', 'antigravity');
    const imageDir = join(stateDir, 'attachments', sessionId);
    const logs = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      nativeId,
      '.system_generated',
      'logs'
    );
    await mkdir(imageDir, { recursive: true });
    await mkdir(logs, { recursive: true });
    const image = join(imageDir, '20cd6333-a693-485d-aaec-1aebc9328db6.png');
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=';
    await writeFile(image, data, 'base64');
    await writeFile(join(stateDir, `${sessionId}.json`), JSON.stringify({ nativeId }));
    const rawText = `[Kullanıcı görsel ekledi: ${image} (MIME: image/png). Görseli incelemek için read_file aracını bu tam dosya yoluyla kullan.]\nEkrana bak`;
    await writeFile(
      join(logs, 'transcript.jsonl'),
      JSON.stringify({ type: 'USER_INPUT', content: `<USER_REQUEST>${rawText}</USER_REQUEST>` })
    );
    sqlite
      .prepare(
        'INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)'
      )
      .run('agy-image', 'Antigravity Chat', 'antigravity', sessionId, 'local');
    const cache = new ConversationTranscriptCache(db, { homeDir });

    const fromLog = await cache.readInstantTranscript('agy-image');
    expect(fromLog.source).toBe('disk');
    expect(fromLog.turns[0]?.items[0]).toMatchObject({
      text: 'Ekrana bak',
      attachments: [{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${data}` }],
    });

    cache.save('agy-image', [
      {
        id: 't1',
        seq: 1,
        initiator: 'user',
        items: [{ kind: 'message', id: 'm1', seq: 1, role: 'user', text: rawText }],
      },
    ]);
    const fromCache = await cache.readInstantTranscript('agy-image');
    expect(fromCache.source).toBe('cache');
    expect(fromCache.turns[0]?.items[0]).toMatchObject({
      text: 'Ekrana bak',
      attachments: [{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${data}` }],
    });
  });

  it('resolves Antigravity bridge sessionId via nativeId into antigravity-cli brain', async () => {
    const stateDir = join(homeDir, '.local', 'state', 'orkestra', 'antigravity');
    const brainDir = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      'native-agy-99',
      '.system_generated',
      'logs'
    );
    await mkdir(stateDir, { recursive: true });
    await mkdir(brainDir, { recursive: true });
    await writeFile(
      join(stateDir, 'bridge-sid-99.json'),
      JSON.stringify({ cwd: '/tmp', nativeId: 'native-agy-99' }),
      'utf8'
    );
    await writeFile(
      join(brainDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'USER_INPUT',
          id: 'u99',
          content: '<USER_REQUEST>Bridge testi</USER_REQUEST>',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          id: 'a99',
          content: 'NativeId çözüldü!',
        }),
      ].join('\n'),
      'utf8'
    );

    sqlite
      .prepare(
        `INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)`
      )
      .run('conv-agy-bridge', 'Bridge Chat', 'antigravity', 'bridge-sid-99', 'local');

    const cache = new ConversationTranscriptCache(db, { homeDir });
    const res = await cache.readInstantTranscript('conv-agy-bridge');
    expect(res.source).toBe('disk');
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]?.items[1]).toMatchObject({ role: 'assistant', text: 'NativeId çözüldü!' });
  });

  it('falls back to message_search_fts for remote SSH conversations', async () => {
    sqlite
      .prepare(
        `INSERT INTO conversations (id, title, provider, provider_session_id, location) VALUES (?, ?, ?, ?, ?)`
      )
      .run('conv-remote', 'Remote Chat', 'antigravity', 'remote-sid-1', 'remote');
    sqlite
      .prepare(
        `INSERT INTO message_search_fts (conversation_id, project_id, task_id, item_id, role, conversation_title, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'conv-remote',
        'p1',
        't1',
        'm1',
        'user',
        'Remote Chat',
        'Sunucudaki durum ne?',
        1700000000000
      );
    sqlite
      .prepare(
        `INSERT INTO message_search_fts (conversation_id, project_id, task_id, item_id, role, conversation_title, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'conv-remote',
        'p1',
        't1',
        'm2',
        'assistant',
        'Remote Chat',
        'Her şey çalışıyor.',
        1700000005000
      );

    const cache = new ConversationTranscriptCache(db, { homeDir });
    const res = await cache.readInstantTranscript('conv-remote');
    expect(res.source).toBe('fts');
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0]?.items).toHaveLength(2);
    expect(res.turns[0]?.items[1]).toMatchObject({ role: 'assistant', text: 'Her şey çalışıyor.' });
  });
});
