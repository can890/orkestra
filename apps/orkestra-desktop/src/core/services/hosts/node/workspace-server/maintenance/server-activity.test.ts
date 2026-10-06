import { ManualClock } from '@orkestra/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  isServerIdle,
  readServerActivity,
  type ServerActivitySources,
  type SessionSummary,
  type TerminalSessionList,
  type TuiSessionList,
} from './server-activity';

const NOW = 10 * 60_000;

function acpSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    conversationId: 'conv-1',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    lastStopReason: null,
    lastTurnErrored: false,
    pendingPermissionCount: 0,
    backgroundAgentCount: 0,
    queuedPromptCount: 0,
    title: 'Fix bug',
    updatedAt: 0,
    ...overrides,
  };
}

function terminal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    key: {
      id,
      workspace: {
        host: { type: 'remote', id: 'ssh-1' },
        path: { root: { kind: 'posix' }, segments: ['home', 'me', 'repo'] },
      },
    },
    status: 'running',
    startCount: 1,
    cols: 80,
    rows: 24,
    startedAt: 0,
    ...overrides,
  };
}

function sources(overrides: Partial<ServerActivitySources> = {}): ServerActivitySources {
  return {
    acpSessions: async () => ({}),
    tuiSessions: async () => ({}),
    terminals: async () => ({}),
    scriptRuns: async () => [],
    scriptDevServers: async () => ({}),
    ...overrides,
  };
}

async function read(input: ServerActivitySources) {
  return readServerActivity(input, { clock: new ManualClock(NOW), sourceTimeoutMs: 1_000 });
}

describe('readServerActivity', () => {
  it('is idle when no runtime reports work', async () => {
    const activity = await read(sources());
    expect(activity).toEqual({ checkedAt: NOW, items: [], complete: true });
    expect(isServerIdle(activity)).toBe(true);
  });

  it('ignores ready, quiet, suspended and closed ACP sessions', async () => {
    const activity = await read(
      sources({
        acpSessions: async () => ({
          a: acpSession({ conversationId: 'a', lastOutputAt: NOW - 6 * 60_000 }),
          b: acpSession({ conversationId: 'b', lifecycle: 'closed', isGenerating: true }),
          c: acpSession({ conversationId: 'c', suspended: true, lifecycle: 'working' }),
        }),
      })
    );
    expect(isServerIdle(activity)).toBe(true);
  });

  it('counts working, generating, waiting and recently active ACP sessions as busy', async () => {
    const activity = await read(
      sources({
        acpSessions: async () => ({
          a: acpSession({ conversationId: 'a', lifecycle: 'working' }),
          b: acpSession({ conversationId: 'b', isGenerating: true }),
          c: acpSession({ conversationId: 'c', pendingPermissionCount: 1 }),
          d: acpSession({ conversationId: 'd', lastInputAt: NOW - 60_000, title: null }),
        }),
      })
    );
    expect(activity.items.map((item) => [item.kind, item.id, item.label])).toEqual([
      ['agent-turn', 'a', 'Fix bug'],
      ['agent-turn', 'b', 'Fix bug'],
      ['agent-turn', 'c', 'Fix bug'],
      ['agent-turn', 'd', 'claude'],
    ]);
    expect(isServerIdle(activity)).toBe(false);
  });

  it('counts running TUI sessions and non-tmux terminals, but not tmux terminals', async () => {
    const tui = {
      t1: {
        conversationId: 't1',
        providerId: 'codex',
        sessionId: null,
        status: 'running',
        cols: 80,
        rows: 24,
        resume: null,
        startedAt: 0,
      },
      t2: {
        conversationId: 't2',
        sessionId: null,
        status: 'exited',
        cols: 80,
        rows: 24,
        resume: null,
        startedAt: 0,
      },
    } as unknown as TuiSessionList;
    const terminals = {
      plain: terminal('plain'),
      tmux: terminal('tmux', { tmux: true }),
      exited: terminal('exited', { status: 'exited' }),
    } as unknown as TerminalSessionList;
    const activity = await read(
      sources({ tuiSessions: async () => tui, terminals: async () => terminals })
    );
    expect(activity.items.map((item) => [item.kind, item.id, item.label])).toEqual([
      ['agent-session', 't1', 'codex'],
      ['terminal', 'plain', 'repo'],
    ]);
  });

  it('lists in-flight scripts on servers that support activeRuns', async () => {
    const activity = await read(
      sources({
        scriptRuns: async () => [
          { workspacePath: '/home/me/repo', script: 'setup', runId: 'r1', startedAt: 1 },
        ],
      })
    );
    expect(activity.items).toEqual([{ kind: 'script', id: 'r1', label: 'setup · repo' }]);
  });

  it('falls back to detected script dev servers on older servers', async () => {
    const activity = await read(
      sources({
        scriptRuns: undefined,
        scriptDevServers: async () => ({
          d1: {
            key: { workspacePath: '/home/me/repo', script: 'run' },
            protocol: 'http:',
            host: 'localhost',
            port: 3000,
            urlPath: '/',
            detectedAt: 1,
          },
        }),
      })
    );
    expect(activity.items).toEqual([{ kind: 'dev-server', id: 'd1', label: 'run · repo :3000' }]);
  });

  it('never reports idle when a runtime cannot be read', async () => {
    const activity = await read(
      sources({
        terminals: async () => {
          throw new Error('worker unavailable');
        },
      })
    );
    expect(activity.complete).toBe(false);
    expect(isServerIdle(activity)).toBe(false);
  });
});
