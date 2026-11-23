import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '@core/services/app-db/node/db';
import { discoverExternalSessions } from './discover-external-sessions';

function fakeDb(knownSessionIds: readonly string[] = []): AppDb {
  return {
    select: () => ({
      from: () => ({
        where: async () => knownSessionIds.map((providerSessionId) => ({ providerSessionId })),
      }),
    }),
  } as unknown as AppDb;
}

describe('discoverExternalSessions', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'orkestra-ext-sessions-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('discovers Claude, Codex, Antigravity and Gemini CLI sessions sorted by mtime and filters boilerplate', async () => {
    const claudeDir = join(homeDir, '.claude', 'projects', '-Users-selim-work-api');
    await mkdir(claudeDir, { recursive: true });
    const claudeFile = join(claudeDir, 'claude-sess-1.jsonl');
    await writeFile(
      claudeFile,
      [
        JSON.stringify({
          type: 'user',
          isMeta: true,
          sessionId: 'claude-sess-1',
          cwd: '/Users/selim/work/api',
          message: { content: 'Meta warmup' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-sess-1',
          cwd: '/Users/selim/work/api',
          message: { content: '<command-name>/init</command-name>' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-sess-1',
          cwd: '/Users/selim/work/api',
          message: { content: 'Add streaming retry logic to ACP client' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Sure' }] },
        }),
      ].join('\n'),
      'utf8'
    );

    const codexDir = join(homeDir, '.codex', 'sessions', '2026', '11', '23');
    await mkdir(codexDir, { recursive: true });
    const codexFile = join(codexDir, 'rollout-2026-11-23-codex-1.jsonl');
    await writeFile(
      codexFile,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'codex-sess-1', cwd: '/Users/selim/Developer/Orkestra-ana' },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions\n...' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Refactor split board layout tree' },
        }),
      ].join('\n'),
      'utf8'
    );

    const agyUuid = '38ca9f8a-2286-44c0-b084-c9d2d40f74af';
    const agyLogsDir = join(
      homeDir,
      '.gemini',
      'antigravity',
      'brain',
      agyUuid,
      '.system_generated',
      'logs'
    );
    await mkdir(agyLogsDir, { recursive: true });
    const agyFile = join(agyLogsDir, 'transcript.jsonl');
    await writeFile(
      agyFile,
      JSON.stringify({
        type: 'USER_INPUT',
        content: [
          'Active Workspaces:',
          '- /Users/selim/Developer/panel',
          '<USER_REQUEST>',
          '  Fix WebSocket reconnect backoff  ',
          '</USER_REQUEST>',
        ].join('\n'),
      }),
      'utf8'
    );

    const geminiChatsDir = join(homeDir, '.gemini', 'tmp', 'proj-hash', 'chats');
    await mkdir(geminiChatsDir, { recursive: true });
    const geminiFile = join(geminiChatsDir, 'session-2026.json');
    await writeFile(
      geminiFile,
      JSON.stringify({
        sessionId: 'gemini-sess-1',
        messages: [{ type: 'user', content: 'Explain SQLite WAL checkpoints' }],
      }),
      'utf8'
    );

    // Deterministic mtimes: agy (newest) > codex > claude > gemini (oldest)
    await utimes(geminiFile, new Date(1_700_000_010_000), new Date(1_700_000_010_000));
    await utimes(claudeFile, new Date(1_700_000_020_000), new Date(1_700_000_020_000));
    await utimes(codexFile, new Date(1_700_000_030_000), new Date(1_700_000_030_000));
    await utimes(agyFile, new Date(1_700_000_040_000), new Date(1_700_000_040_000));

    const results = await discoverExternalSessions(fakeDb(), { homeDir });
    expect(results.map((r) => r.id)).toEqual([
      `antigravity:${agyUuid}`,
      'codex:codex-sess-1',
      'claude:claude-sess-1',
      'gemini:gemini-sess-1',
    ]);

    expect(results[0]).toMatchObject({
      providerId: 'antigravity',
      nativeSessionId: agyUuid,
      title: 'Fix WebSocket reconnect backoff',
      cwd: '/Users/selim/Developer/panel',
      projectLabel: 'panel',
    });
    expect(results[1]).toMatchObject({
      providerId: 'codex',
      nativeSessionId: 'codex-sess-1',
      title: 'Refactor split board layout tree',
      cwd: '/Users/selim/Developer/Orkestra-ana',
      projectLabel: 'Orkestra-ana',
      model: 'gpt-5.3-codex',
    });
    expect(results[2]).toMatchObject({
      providerId: 'claude',
      nativeSessionId: 'claude-sess-1',
      title: 'Add streaming retry logic to ACP client',
      cwd: '/Users/selim/work/api',
      projectLabel: 'api',
      model: 'claude-sonnet-4-5',
    });
    expect(results[3]).toMatchObject({
      providerId: 'gemini',
      nativeSessionId: 'gemini-sess-1',
      title: 'Explain SQLite WAL checkpoints',
      cwd: null,
      projectLabel: 'Gemini CLI',
    });
  });

  it('deduplicates sessions whose providerSessionId already exists in Orkestra SQLite and respects limit', async () => {
    const claudeDir = join(homeDir, '.claude', 'projects', 'p');
    await mkdir(claudeDir, { recursive: true });
    const knownFile = join(claudeDir, 'known.jsonl');
    const freshFile = join(claudeDir, 'fresh.jsonl');
    await writeFile(
      knownFile,
      JSON.stringify({
        type: 'user',
        sessionId: 'already-imported-sess',
        cwd: '/Users/selim/work/repo',
        message: { content: 'Already in Orkestra' },
      }),
      'utf8'
    );
    await writeFile(
      freshFile,
      JSON.stringify({
        type: 'user',
        sessionId: 'fresh-sess',
        cwd: '/Users/selim/work/repo',
        message: { content: 'Brand new external session' },
      }),
      'utf8'
    );

    const results = await discoverExternalSessions(fakeDb(['already-imported-sess']), {
      homeDir,
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.nativeSessionId).toBe('fresh-sess');
  });

  it('ignores boilerplate-only transcripts', async () => {
    const claudeDir = join(homeDir, '.claude', 'projects', 'p');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'empty.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'boilerplate-only',
        message: { content: '<system-reminder>System prompt</system-reminder>' },
      }),
      'utf8'
    );

    const results = await discoverExternalSessions(fakeDb(), { homeDir });
    expect(results).toEqual([]);
  });
});
