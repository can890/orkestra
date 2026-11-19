import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import { isOk } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '#runtimes/acp/node/acp-test-support';
import { SessionCell } from './cell';

function makePendingCell(agent = new FakeAcpAgent()) {
  const cell = new SessionCell({
    conversationId: 'conv-1',
    providerId: 'claude',
    acpSessionId: 'session-1',
    agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
  });
  return { cell, agent };
}

function makeCell(agent = new FakeAcpAgent()) {
  const result = makePendingCell(agent);
  const { cell } = result;
  cell.applySessionReady();
  return result;
}

describe('SessionCell prompts', () => {
  it('keeps MCP startup failures out of transcript and agent activity', () => {
    const { cell } = makeCell();
    cell.push({ kind: 'mcp_startup_failure', server: 'docs', error: 'Connection refused' });
    expect(cell.mcpStartupFailures.get('docs')).toBe('Connection refused');
    expect(cell.history()).toEqual({ committed: [], active: null });
    expect(cell.sessionState.agentTurnActive).toBe(false);
    expect(cell.sessionState.isGenerating).toBe(false);
    expect(makeCell().cell.mcpStartupFailures.size).toBe(0);
  });

  it('synthesizes a user message and settles the turn', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    const result = await cell.prompt({ text: 'hello' });

    expect(result).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    const history = cell.history();
    expect(history.active).toBeNull();
    expect(history.committed).toHaveLength(1);
    expect(history.committed[0].items[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'hello',
    });
    expect(history.committed[0].outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('queues while working and drains after the active turn settles', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopReason: 'end_turn' }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first' });
    const second = await cell.prompt({ text: 'second' });

    expect(second).toEqual({ success: true, data: { queued: true } });
    expect(cell.sessionState.queuedPrompts).toHaveLength(1);
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
  });

  it('keeps prompts queued while background agents run and drains after cancel settles them', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    cell.push({
      kind: 'subagent',
      toolCallId: 'tool-1',
      agentId: 'agent-1',
      title: 'Background agent',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
    });
    expect(cell.sessionState.backgroundAgentCount).toBe(1);

    const queued = await cell.prompt({ text: 'queued' });
    expect(queued).toEqual({ success: true, data: { queued: true } });
    expect(agent.prompt).not.toHaveBeenCalled();

    await cell.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'failed' }]);
    expect(cell.sessionState.backgroundAgentCount).toBe(0);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'queued' }],
    });
  });
});

describe('SessionCell permissions', () => {
  it('brokers permission requests through the per-cell broker', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Read a file', kind: 'read' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as PermissionOptionKind }],
    });

    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
    expect(cell.sessionState.pendingPermissions[0].toolCall).toMatchObject({
      kind: 'read-tool-call',
      toolCallId: 'tool-1',
    });

    const result = cell.resolvePermission(
      cell.sessionState.pendingPermissions[0].requestId,
      'allow'
    );
    expect(isOk(result)).toBe(true);
    await expect(permission).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);
  });

  it('drains pending permissions on dispose', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-2', title: 'Write a file', kind: 'edit' },
      options: [
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' as PermissionOptionKind },
      ],
    });

    cell.dispose();

    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('SessionCell config options', () => {
  it('distinguishes a pending config catalog from an authoritative empty catalog', () => {
    const { cell } = makePendingCell();

    expect(cell.configCatalog).toEqual({ kind: 'pending' });

    cell.applySessionReady();

    expect(cell.configCatalog).toEqual({
      kind: 'ready',
      config: {
        modelOptions: null,
        efforts: null,
        modeOptions: null,
        collaborationModeOptions: null,
      },
    });
  });

  it('sets mode through the provider config option and seeds the response', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent-full-access',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });

    const result = await cell.setMode('agent-full-access');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'mode',
      value: 'agent-full-access',
    });
    expect(agent.setSessionMode).not.toHaveBeenCalled();
    expect(cell.config.modeOptions?.selected).toBe('agent-full-access');
  });

  it('falls back to setSessionMode when config updates are unavailable', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'read-only', name: 'Read-only' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = undefined as unknown as typeof agent.setSessionConfigOption;

    const result = await cell.setMode('read-only');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'read-only',
    });
  });

  it('resolves effort dimension to the provider config option id', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });

    const result = await cell.setConfigOption('effort', 'high');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'reasoning_effort',
      value: 'high',
    });
    expect(cell.config.efforts?.selected).toBe('high');
  });

  it('sets collaboration mode independently from permission mode', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Permissions',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [{ value: 'agent', name: 'Agent' }],
        },
        {
          id: 'collaboration_mode',
          name: 'Collaboration mode',
          category: 'collaboration_mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Permissions',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [{ value: 'agent', name: 'Agent' }],
        },
        {
          id: 'collaboration_mode',
          category: 'collaboration_mode',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });

    const result = await cell.setConfigOption('collaborationMode', 'plan');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'collaboration_mode',
      value: 'plan',
    });
    expect(cell.config.collaborationModeOptions?.selected).toBe('plan');
    expect(cell.config.modeOptions?.selected).toBe('agent');
  });
});

describe('SessionCell idle turns and queue commands', () => {
  it('amends a completed tool without starting agent activity or an idle timer', () => {
    vi.useFakeTimers();
    const { cell } = makeCell();
    try {
      cell.transcript.pushEvent(
        {
          kind: 'tool_call',
          toolCallId: 'old',
          title: 'Run',
          toolKind: 'execute',
          status: 'in_progress',
          parentToolCallId: null,
          diffs: [],
          locations: [],
        },
        0
      );
      cell.transcript.endTurn(10);
      cell.push({
        kind: 'tool_update',
        toolCallId: 'old',
        status: 'failed',
        parentToolCallId: null,
        outputText: 'late failure',
      });
      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.sessionState.isGenerating).toBe(false);
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed[0].items[0]).toMatchObject({
        toolCallId: 'old',
        status: 'error',
        outputText: 'late failure',
      });
      expect(cell.sessionState.historyRevision).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cell.dispose();
      vi.useRealTimers();
    }
  });

  it('does not mistake idle plan revisions or unmatched tool updates for agent activity', () => {
    const { cell } = makeCell();
    try {
      cell.push({ kind: 'plan', entries: [] });
      cell.push({
        kind: 'tool_update',
        toolCallId: 'unknown',
        parentToolCallId: null,
        status: 'completed',
      });
      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.history()).toEqual({ committed: [], active: null });
    } finally {
      cell.dispose();
    }
  });

  it('settles idle agent turns after quiesce', async () => {
    vi.useFakeTimers();
    try {
      const { cell } = makeCell();

      cell.push({
        kind: 'message',
        role: 'assistant',
        messageId: null,
        text: 'An unsolicited response',
      });

      expect(cell.sessionState.agentTurnActive).toBe(true);
      expect(cell.history().active?.initiator).toBe('agent');

      vi.advanceTimersByTime(300);
      await Promise.resolve();

      expect(cell.sessionState.agentTurnActive).toBe(false);
      expect(cell.history().active).toBeNull();
      expect(cell.history().committed.at(-1)?.outcome).toEqual({
        kind: 'done',
        reason: 'quiesced',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues, edits, removes, and reorders queued prompts', () => {
    const { cell } = makeCell();

    // Keep the session busy so reordering an idle queue does not drain its head
    // (QueueReordered dispatches the new head when the session is idle).
    cell.push({
      kind: 'subagent',
      toolCallId: 'tool-1',
      agentId: 'agent-1',
      title: 'Background agent',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
    });

    expect(isOk(cell.queuePrompt({ text: 'a' }))).toBe(true);
    expect(isOk(cell.queuePrompt({ text: 'b' }))).toBe(true);
    const [first, second] = cell.sessionState.queuedPrompts;

    expect(isOk(cell.editQueuedPrompt(first.id, { text: 'edited' }))).toBe(true);
    expect(isOk(cell.reorderQueue([second.id, first.id]))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(cell.sessionState.queuedPrompts[1].text).toBe('edited');

    expect(isOk(cell.removeQueuedPrompt(first.id))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([second.id]);
  });
});

describe('SessionCell steering', () => {
  function makeSteerCell(options: { supportsSteering?: boolean; supportsImages?: boolean } = {}) {
    const agent = new FakeAcpAgent();
    const cell = new SessionCell({
      conversationId: 'conv-1',
      providerId: 'claude',
      acpSessionId: 'session-1',
      agent,
      supportsSteering: options.supportsSteering ?? true,
      supportsImages: options.supportsImages,
      resolveAttachment: vi.fn().mockResolvedValue({
        data: 'AAAA',
        mimeType: 'image/png',
        name: 'a.png',
        targetPath: '/ws/a.png',
      }),
      logger: noopLogger,
    });
    cell.applySessionReady();
    let finishTurn!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          finishTurn = resolve;
        })
    );
    return { cell, agent, finishTurn: () => finishTurn({ stopReason: 'end_turn' }) };
  }

  const steeringParams = (prompt: unknown[]) => ({
    sessionId: 'session-1',
    prompt,
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  });

  it('injects into the running turn without changing phase, turn count or the queue', async () => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    const before = cell.machine.current();

    const steered = await cell.steer(
      { text: 'son durum ne?' },
      { id: 'steer-1', onAccepted: vi.fn(), resolvedAttachments: [] }
    );

    expect(steered).toBe(true);
    expect(agent.extMethod).toHaveBeenCalledWith(
      '_session/steering',
      steeringParams([{ type: 'text', text: 'son durum ne?' }])
    );
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    const after = cell.machine.current();
    expect(after.phase).toEqual(before.phase);
    expect(after.nextTurnIndex).toBe(before.nextTurnIndex);
    expect(after.queuedPrompts).toEqual([]);
    expect(cell.sessionState.lifecycle).toBe('working');

    // Exactly one user row for the steered message, starting its own transcript turn.
    const userRows = [
      ...cell.history().committed.flatMap((t) => t.items),
      ...(cell.history().active?.items ?? []),
    ].filter((item) => item.kind === 'message' && item.role === 'user');
    expect(userRows.map((row) => (row as { text: string }).text)).toEqual([
      'work',
      'son durum ne?',
    ]);
    expect(userRows[1]).toMatchObject({ promptId: 'steer-1' });

    finishTurn();
    await first;
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  it('does not emit PromptStarted or TurnEnded for an injected prompt', async () => {
    const { cell, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    const batches: string[] = [];
    cell.machine.subscribe((batch) => {
      for (const event of batch.events) batches.push(event.type);
    });

    await cell.steer({ text: 'hi' });

    expect(batches).toEqual(['PromptSteered']);
    finishTurn();
    await first;
  });

  it('sends image blocks only when the agent accepts images', async () => {
    const attachments = [{ type: 'attachment' as const, id: 'a', mimeType: 'image/png' as const }];
    const withImages = makeSteerCell({ supportsImages: true });
    void withImages.cell.prompt({ text: 'work' });
    await withImages.cell.steer({ text: 'look', attachments });
    const blocks = withImages.agent.extMethod.mock.calls[0][1].prompt as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toContain('image');

    const textOnly = makeSteerCell({ supportsImages: false });
    void textOnly.cell.prompt({ text: 'work' });
    await textOnly.cell.steer({ text: 'look', attachments });
    const textBlocks = textOnly.agent.extMethod.mock.calls[0][1].prompt as Array<{ type: string }>;
    expect(textBlocks.map((b) => b.type)).not.toContain('image');
  });

  it.each([
    ['promptRequired', { outcome: 'promptRequired', reason: 'noRunningTurn' }],
    ['failed', { outcome: 'failed' }],
    ['an unknown outcome', { outcome: 'surprise' }],
    ['a malformed response', null],
  ])('falls back (nothing recorded) on %s', async (_label, response) => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    agent.extMethod.mockResolvedValueOnce(response);

    expect(await cell.steer({ text: 'hi' })).toBe(false);

    expect(cell.history().active?.items.filter((i) => i.kind === 'message')).toHaveLength(1);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    finishTurn();
    await first;
  });

  it('falls back when the steering request throws', async () => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    agent.extMethod.mockRejectedValueOnce(new Error('boom'));

    expect(await cell.steer({ text: 'hi' })).toBe(false);
    expect(cell.sessionState.lifecycle).toBe('working');
    finishTurn();
    await first;
  });

  it('never calls the agent when steering is unsupported, extMethod is missing or no turn runs', async () => {
    const unsupported = makeSteerCell({ supportsSteering: false });
    void unsupported.cell.prompt({ text: 'work' });
    expect(await unsupported.cell.steer({ text: 'hi' })).toBe(false);
    expect(unsupported.agent.extMethod).not.toHaveBeenCalled();
    expect(unsupported.cell.sessionState.supportsSteering).toBeUndefined();

    const noExt = makeSteerCell();
    void noExt.cell.prompt({ text: 'work' });
    (noExt.agent as { extMethod?: unknown }).extMethod = undefined;
    expect(await noExt.cell.steer({ text: 'hi' })).toBe(false);

    const idle = makeSteerCell();
    expect(idle.cell.sessionState.supportsSteering).toBe(true);
    expect(await idle.cell.steer({ text: 'hi' })).toBe(false);
    expect(idle.agent.extMethod).not.toHaveBeenCalled();
  });

  it('does not steer while cancelling', async () => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    void cell.cancel();
    expect(cell.sessionState.lifecycle).toBe('cancelling');
    expect(await cell.steer({ text: 'hi' })).toBe(false);
    expect(agent.extMethod).not.toHaveBeenCalled();
    finishTurn();
    await first;
  });

  it('treats startedNewTurn after the turn settled as agent-originated activity', async () => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    agent.extMethod.mockImplementationOnce(async () => {
      // The turn settles while the steering request is still in flight.
      finishTurn();
      await first;
      return { outcome: 'startedNewTurn' };
    });

    expect(await cell.steer({ text: 'hi' })).toBe(true);

    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.agentTurnActive).toBe(true);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    // The reply streams through ordinary updates and quiesces into a settled, consistent state.
    vi.useFakeTimers();
    try {
      cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'durum' });
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(cell.sessionState.agentTurnActive).toBe(false);
    expect(cell.sessionState.isGenerating).toBe(false);
    expect(
      cell
        .history()
        .committed.flatMap((t) => t.items)
        .filter((i) => i.kind === 'message' && i.role === 'user').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('treats startedNewTurn during a working turn like an injection (no resend)', async () => {
    const { cell, agent, finishTurn } = makeSteerCell();
    const first = cell.prompt({ text: 'work' });
    agent.extMethod.mockResolvedValueOnce({ outcome: 'startedNewTurn' });

    expect(await cell.steer({ text: 'hi' })).toBe(true);
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    finishTurn();
    await first;
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });
});
