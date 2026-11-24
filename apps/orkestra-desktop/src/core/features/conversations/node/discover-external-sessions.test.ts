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

  it('discovers Claude, Codex, and Antigravity sessions sorted by mtime and filters boilerplate / sidechains / ssh', async () => {
    const claudeCwd = join(homeDir, 'work', 'api');
    const codexCwd = join(homeDir, 'Developer', 'Orkestra-ana');
    const agyCwd = join(homeDir, 'Developer', 'panel');
    await Promise.all([
      mkdir(claudeCwd, { recursive: true }),
      mkdir(codexCwd, { recursive: true }),
      mkdir(agyCwd, { recursive: true }),
    ]);

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
          cwd: claudeCwd,
          message: { content: 'Meta warmup' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-sess-1',
          cwd: claudeCwd,
          message: { content: '<command-name>/init</command-name>' },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-sess-1',
          cwd: claudeCwd,
          message: { content: 'Add streaming retry logic to ACP client' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Sure' }] },
        }),
      ].join('\n'),
      'utf8'
    );

    // Subagent / sidechain / remote ssh-* / worker boilerplate should all be ignored
    await writeFile(
      join(claudeDir, 'agent-worker.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'agent-sess',
        cwd: claudeCwd,
        message: { content: 'Subagent task' },
      }),
      'utf8'
    );
    await writeFile(
      join(claudeDir, 'sidechain-sess.jsonl'),
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        sessionId: 'sidechain-sess',
        cwd: claudeCwd,
        message: { content: 'Sidechain branch prompt' },
      }),
      'utf8'
    );
    await writeFile(
      join(claudeDir, 'worker-prompt.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'worker-sess',
        cwd: claudeCwd,
        message: { content: 'Sen bir işçisin. Yalnızca şu dosyaya bak.' },
      }),
      'utf8'
    );
    const sshClaudeDir = join(homeDir, '.claude', 'projects', 'ssh-remote-id');
    await mkdir(sshClaudeDir, { recursive: true });
    await writeFile(
      join(sshClaudeDir, 'remote.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'remote-ssh-sess',
        cwd: '/home/selim/projects/remote',
        message: { content: 'Remote prompt' },
      }),
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
          payload: { id: 'codex-sess-1', cwd: codexCwd },
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
          `- ${agyCwd}`,
          '<USER_REQUEST>',
          '  Fix WebSocket reconnect backoff  ',
          '</USER_REQUEST>',
        ].join('\n'),
      }),
      'utf8'
    );

    // Bridge state file with stricter local cwd overrides workspace parsed from transcript
    const bridgeCwd = join(homeDir, 'bridge-cwd');
    await mkdir(bridgeCwd, { recursive: true });
    const agyStateDir = join(homeDir, '.local', 'state', 'orkestra', 'antigravity');
    await mkdir(agyStateDir, { recursive: true });
    await writeFile(
      join(agyStateDir, `${agyUuid}.json`),
      JSON.stringify({ cwd: bridgeCwd }),
      'utf8'
    );

    // Unsupported gemini CLI folder should not break or appear
    const geminiChatsDir = join(homeDir, '.gemini', 'tmp', 'proj-hash', 'chats');
    await mkdir(geminiChatsDir, { recursive: true });
    await writeFile(
      join(geminiChatsDir, 'session-2026.json'),
      JSON.stringify({
        sessionId: 'gemini-sess-1',
        messages: [{ type: 'user', content: 'Explain SQLite WAL checkpoints' }],
      }),
      'utf8'
    );

    await utimes(claudeFile, new Date(1_700_000_020_000), new Date(1_700_000_020_000));
    await utimes(codexFile, new Date(1_700_000_030_000), new Date(1_700_000_030_000));
    await utimes(agyFile, new Date(1_700_000_040_000), new Date(1_700_000_040_000));

    const results = await discoverExternalSessions(fakeDb(), { homeDir });
    expect(results.map((r) => r.id)).toEqual([
      `antigravity:${agyUuid}`,
      'codex:codex-sess-1',
      'claude:claude-sess-1',
    ]);

    expect(results[0]).toMatchObject({
      providerId: 'antigravity',
      nativeSessionId: agyUuid,
      title: 'Fix WebSocket reconnect backoff',
      cwd: bridgeCwd,
      projectLabel: 'bridge-cwd',
    });
    expect(results[1]).toMatchObject({
      providerId: 'codex',
      nativeSessionId: 'codex-sess-1',
      title: 'Refactor split board layout tree',
      cwd: codexCwd,
      projectLabel: 'Orkestra-ana',
      model: 'gpt-5.3-codex',
    });
    expect(results[2]).toMatchObject({
      providerId: 'claude',
      nativeSessionId: 'claude-sess-1',
      title: 'Add streaming retry logic to ACP client',
      cwd: claudeCwd,
      projectLabel: 'api',
      model: 'claude-sonnet-4-5',
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
        cwd: '/nonexistent/path/for/fallback',
        message: { content: 'Already in Orkestra' },
      }),
      'utf8'
    );
    await writeFile(
      freshFile,
      JSON.stringify({
        type: 'user',
        sessionId: 'fresh-sess',
        cwd: '/nonexistent/path/for/fallback',
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
    expect(results[0]?.cwd).toBeNull();
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
