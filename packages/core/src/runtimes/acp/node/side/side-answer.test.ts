import { noopLogger } from '@orkestra/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, makeAcpHarness } from '../acp-test-support';
import { createSideAnswerRunner, pickReadOnlyMode, rejectPermission } from './side-answer';

function setup(timeoutMs?: number) {
  const agent = new FakeAcpAgent();
  agent.newSession = vi.fn().mockResolvedValue({
    sessionId: 'side-1',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Standart' },
          { value: 'plan', name: 'Plan' },
          { value: 'auto', name: 'Otomatik' },
        ],
      },
    ],
  });
  const h = makeAcpHarness({
    acpBehavior: {
      buildSpawn: () => ({ command: '/fake/agent', args: [], env: {} }),
      connect: agent.behavior.connect,
    },
  });
  const run = createSideAnswerRunner({
    host: h.deps.host,
    agentHost: h.deps.agentHost,
    logger: noopLogger,
    timeoutMs,
  });
  const base = { providerId: 'claude', cwd: '/tmp/workspace', prompt: 'P' };
  return { agent, h, run, base };
}

const chunk = (text: string) => ({
  sessionId: 'side-1',
  update: {
    sessionUpdate: 'agent_message_chunk' as const,
    content: { type: 'text' as const, text },
  },
});

describe('createSideAnswerRunner', () => {
  it('streams chunks, selects model and read-only mode, then closes the session and kills the process', async () => {
    const { agent, h, run, base } = setup();
    agent.prompt = vi.fn(async () => {
      await agent.capturedClient!.sessionUpdate(chunk('Üç '));
      await agent.capturedClient!.sessionUpdate(chunk('dosya.'));
      return { stopReason: 'end_turn' as const };
    });
    const onText = vi.fn();

    const result = await run({ ...base, model: 'b', signal: new AbortController().signal, onText });

    expect(result.success).toBe(true);
    expect(onText.mock.calls.map(([t]) => t)).toEqual(['Üç ', 'dosya.']);
    expect(agent.newSession).toHaveBeenCalledWith({ cwd: '/tmp/workspace', mcpServers: [] });
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'side-1',
      configId: 'model',
      value: 'b',
    });
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'side-1',
      configId: 'mode',
      value: 'plan',
    });
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'side-1',
      prompt: [{ type: 'text', text: 'P' }],
    });
    expect(agent.closeSession).toHaveBeenCalledWith({ sessionId: 'side-1' });
    expect(h.children).toHaveLength(1);
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it('skips a model the transient session does not offer', async () => {
    const { agent, run, base } = setup();
    await run({ ...base, model: 'zzz', signal: new AbortController().signal, onText: vi.fn() });
    expect(agent.setSessionConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ configId: 'model' })
    );
  });

  it('rejects every permission request and never exposes files or terminals', async () => {
    const { agent, run, base } = setup();
    let permission: unknown;
    let write: unknown;
    agent.prompt = vi.fn(async () => {
      permission = await agent.capturedClient!.requestPermission({
        sessionId: 'side-1',
        toolCall: { toolCallId: 't' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      } as never);
      try {
        await agent.capturedClient!.writeTextFile!({
          sessionId: 'side-1',
          path: '/x',
          content: 'y',
        });
      } catch (error) {
        write = (error as Error).message;
      }
      return { stopReason: 'end_turn' as const };
    });

    await run({ ...base, signal: new AbortController().signal, onText: vi.fn() });

    expect(permission).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(write).toMatch(/dosya yazamaz/);
  });

  it('times out, cancels the prompt and still releases the process', async () => {
    const { agent, h, run, base } = setup(20);
    agent.prompt = vi.fn(() => new Promise(() => {}));

    const result = await run({ ...base, signal: new AbortController().signal, onText: vi.fn() });

    expect(result).toMatchObject({ success: false, error: { type: 'timeout' } });
    expect(agent.cancel).toHaveBeenCalledWith({ sessionId: 'side-1' });
    expect(agent.closeSession).toHaveBeenCalled();
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it('aborts mid-answer and releases the process', async () => {
    const { agent, h, run, base } = setup();
    agent.prompt = vi.fn(() => new Promise(() => {}));
    const abort = new AbortController();
    const running = run({ ...base, signal: abort.signal, onText: vi.fn() });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalled());

    abort.abort();

    await expect(running).resolves.toMatchObject({ success: false, error: { type: 'aborted' } });
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it('reports a failing prompt and still tears down', async () => {
    const { agent, h, run, base } = setup();
    agent.prompt = vi.fn().mockRejectedValue(new Error('kota doldu'));

    const result = await run({ ...base, signal: new AbortController().signal, onText: vi.fn() });

    expect(result).toMatchObject({
      success: false,
      error: { type: 'failed', message: 'kota doldu' },
    });
    expect(agent.closeSession).toHaveBeenCalled();
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it('does not spawn at all when already aborted', async () => {
    const { h, run, base } = setup();
    const abort = new AbortController();
    abort.abort();
    const result = await run({ ...base, signal: abort.signal, onText: vi.fn() });
    expect(result).toMatchObject({ success: false, error: { type: 'aborted' } });
    expect(h.children.length === 0 || h.children[0].kill.mock.calls.length > 0).toBe(true);
  });
});

describe('read-only helpers', () => {
  it('prefers a plan mode and never picks an approving one', () => {
    expect(pickReadOnlyMode([{ id: 'default' }, { id: 'plan' }, { id: 'auto' }])).toBe('plan');
    expect(pickReadOnlyMode([{ id: 'read-only', name: 'Read Only' }, { id: 'full-access' }])).toBe(
      'read-only'
    );
    expect(pickReadOnlyMode([{ id: 'default' }, { id: 'acceptEdits' }])).toBeNull();
  });

  it('cancels when the agent offers only approving options', () => {
    expect(
      rejectPermission({
        sessionId: 's',
        toolCall: { toolCallId: 't' },
        options: [{ optionId: 'y', name: 'Allow', kind: 'allow_always' }],
      } as never)
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
