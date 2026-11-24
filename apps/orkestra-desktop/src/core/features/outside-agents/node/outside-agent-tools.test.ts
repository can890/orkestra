import { describe, expect, it } from 'vitest';
import {
  conversationStatus,
  OUTSIDE_AGENT_TOOLS,
  READ_TOTAL_CHAR_BUDGET,
  type ToolContext,
} from './outside-agent-tools';
import { FakeBackend } from './testing/fakes';

function tool(name: string) {
  const found = OUTSIDE_AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(name);
  return found;
}

async function run(name: string, args: unknown, ctx: ToolContext) {
  const definition = tool(name);
  return definition.run(ctx, definition.input.parse(args) as never) as Promise<any>;
}

function context(backend = new FakeBackend()): ToolContext {
  return { backend, access: 'act', clientName: 'test', sleep: async () => {} };
}

const summary = {
  lifecycle: 'ready',
  suspended: false,
  isGenerating: false,
  pendingPermissionCount: 0,
  queuedPromptCount: 0,
  lastTurnErrored: false,
  updatedAt: 1,
};

describe('conversationStatus', () => {
  it('prefers the live session summary', () => {
    const base = { agentStatus: 'completed' as const, hasSession: true };
    expect(conversationStatus(base, { ...summary, pendingPermissionCount: 2 }).state).toBe(
      'waiting_for_approval'
    );
    expect(conversationStatus(base, { ...summary, isGenerating: true }).state).toBe('working');
    expect(conversationStatus(base, { ...summary, lifecycle: 'starting' }).state).toBe('starting');
    expect(conversationStatus(base, { ...summary, lastTurnErrored: true }).state).toBe('error');
    expect(conversationStatus(base, summary)).toEqual({
      state: 'finished',
      live: true,
      pendingApprovals: 0,
      queuedMessages: 0,
    });
  });

  it('falls back to the stored agent status when the session is not live', () => {
    const suspended = { ...summary, suspended: true };
    expect(
      conversationStatus({ agentStatus: 'awaiting-input', hasSession: true }, suspended).state
    ).toBe('waiting_for_approval');
    expect(conversationStatus({ agentStatus: null, hasSession: false }, undefined).state).toBe(
      'not_started'
    );
    expect(conversationStatus({ agentStatus: 'idle', hasSession: true }, undefined).state).toBe(
      'finished'
    );
  });
});

describe('outside agent tools', () => {
  it('pages conversations newest first and filters by state', async () => {
    const ctx = context();
    const first = await run('orkestra_conversation_list', { limit: 1 }, ctx);
    expect(first.conversations.map((entry: any) => entry.conversationId)).toEqual(['conv-2']);
    expect(first.nextCursor).toBe(1);
    expect(first.conversations[0].projectName).toBe('Beta');
    const second = await run('orkestra_conversation_list', { limit: 1, cursor: 1 }, ctx);
    expect(second.conversations.map((entry: any) => entry.conversationId)).toEqual(['conv-1']);
    expect(second.nextCursor).toBeNull();
    const working = await run('orkestra_conversation_list', { state: 'working' }, ctx);
    expect(working.total).toBe(1);
  });

  it('pages a saved transcript backwards and caps message size', async () => {
    const ctx = context();
    const latest = await run(
      'orkestra_conversation_read',
      { conversationId: 'conv-1', limit: 3, maxCharsPerMessage: 200 },
      ctx
    );
    expect(latest.turns.map((turn: any) => turn.turn)).toEqual([13, 14, 15]);
    const answer = latest.turns[2].items.find((item: any) => item.role === 'assistant');
    expect(answer.text).toHaveLength(200);
    expect(answer.truncated).toBe(true);
    expect(latest.turns[2].items.some((item: any) => item.type === 'tool')).toBe(false);
    const older = await run(
      'orkestra_conversation_read',
      { conversationId: 'conv-1', limit: 3, before: latest.nextBefore, includeToolCalls: true },
      ctx
    );
    expect(older.turns.map((turn: any) => turn.turn)).toEqual([10, 11, 12]);
    expect(older.turns[0].items[1]).toEqual({
      type: 'tool',
      title: 'Run tests',
      status: 'completed',
    });
  });

  it('keeps a huge transcript under the response budget, newest turns first', async () => {
    const backend = new FakeBackend();
    backend.cached['conv-1'] = Array.from({ length: 50 }, (_, index) => ({
      seq: index + 1,
      outcome: 'done',
      items: [
        {
          kind: 'message' as const,
          role: 'assistant' as const,
          text: 'y'.repeat(50_000),
          createdAt: null,
        },
      ],
    }));
    const result = await run(
      'orkestra_conversation_read',
      { conversationId: 'conv-1', limit: 50, maxCharsPerMessage: 20_000 },
      context(backend)
    );
    const total = result.turns
      .flatMap((turn: any) => turn.items)
      .reduce((sum: number, item: any) => sum + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(READ_TOTAL_CHAR_BUDGET);
    expect(result.turns.at(-1).turn).toBe(50);
    expect(result.notes[0]).toContain('size limit');
    expect(result.nextBefore).toBe(`saved:${result.turns[0].turn}`);
  });

  it('validates provider, model and installation before starting', async () => {
    const backend = new FakeBackend();
    const ctx = context(backend);
    await expect(
      run(
        'orkestra_conversation_start',
        { projectId: 'nope', provider: 'claude', message: 'x' },
        ctx
      )
    ).rejects.toThrow(/Unknown projectId/);
    await expect(
      run(
        'orkestra_conversation_start',
        { projectId: 'project-1', provider: 'zzz', message: 'x' },
        ctx
      )
    ).rejects.toThrow(/Unknown provider/);
    await expect(
      run(
        'orkestra_conversation_start',
        { projectId: 'project-1', provider: 'gemini', message: 'x' },
        ctx
      )
    ).rejects.toThrow(/not installed/);
    await expect(
      run(
        'orkestra_conversation_start',
        { projectId: 'project-1', provider: 'claude', model: 'haiku-0', message: 'x' },
        ctx
      )
    ).rejects.toThrow(/Unknown model/);
    expect(backend.started).toHaveLength(0);
  });

  it('refuses to send to terminal conversations', async () => {
    const backend = new FakeBackend();
    backend.conversations[0] = { ...backend.conversations[0]!, type: 'pty' };
    await expect(
      run(
        'orkestra_conversation_send',
        { conversationId: 'conv-1', message: 'hi' },
        context(backend)
      )
    ).rejects.toThrow(/terminal conversation/);
  });

  it('waits until a working conversation settles or times out', async () => {
    const backend = new FakeBackend();
    let clock = 0;
    let polls = 0;
    const ctx: ToolContext = {
      ...context(backend),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        polls += 1;
        if (polls === 3)
          backend.conversations[1] = { ...backend.conversations[1]!, agentStatus: 'completed' };
      },
    };
    const settled = await run('orkestra_conversation_wait', { conversationId: 'conv-2' }, ctx);
    expect(settled).toMatchObject({ timedOut: false, status: { state: 'finished' } });

    backend.conversations[1] = { ...backend.conversations[1]!, agentStatus: 'working' };
    clock = 0;
    polls = 100;
    const timedOut = await run(
      'orkestra_conversation_wait',
      { conversationId: 'conv-2', timeoutSeconds: 3 },
      ctx
    );
    expect(timedOut).toMatchObject({ timedOut: true, status: { state: 'working' } });
  });

  it('marks acting tools and keeps tool names under the orkestra_ prefix', () => {
    for (const definition of OUTSIDE_AGENT_TOOLS) {
      expect(definition.name).toMatch(/^orkestra_[a-z_]+$/);
      expect(definition.description.length).toBeGreaterThan(60);
    }
    expect(OUTSIDE_AGENT_TOOLS.filter((t) => t.requires === 'act').map((t) => t.name)).toEqual([
      'orkestra_conversation_start',
      'orkestra_conversation_send',
    ]);
  });
});
