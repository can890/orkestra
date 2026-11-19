import { isOk } from '@orkestra/shared';
import { deferred } from '@orkestra/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const STEERING_META = { steering: { supported: true } };

async function launch(options: { advertise?: boolean } = {}) {
  const h = makeAcpHarness();
  h.agent.initialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    ...(options.advertise === false ? {} : { _meta: STEERING_META }),
  });
  const rt = new AcpRuntime(h.deps);
  const started = await rt.launchSession(makeStartInput({ conversationId: 'conv-1' }));
  expect(isOk(started)).toBe(true);
  const turn = deferred<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockReturnValueOnce(turn.promise);
  return { h, rt, turn };
}

async function userTexts(rt: AcpRuntime): Promise<string[]> {
  const history = await rt.loadHistory('conv-1');
  if (!isOk(history)) return [];
  const active = rt.getSessionState('conv-1').transcript?.activeTurn;
  return [...history.data.turns, ...(active ? [active] : [])]
    .flatMap((turn) => turn.items)
    .filter((item) => item.kind === 'message' && item.role === 'user')
    .map((item) => (item as { text: string }).text);
}

describe('steering a running turn', () => {
  it('injects through _session/steering, records the message once and leaves the turn alone', async () => {
    const { h, rt, turn } = await launch();
    await rt.sendPrompt('conv-1', { text: 'work' });
    expect(rt.getSessionState('conv-1').supportsSteering).toBe(true);

    const steered = await rt.sendPrompt(
      'conv-1',
      { text: 'son durum ne?' },
      'steer',
      '8a7f8c2e-1d63-4a8e-9c2c-9f3a0f0a0001'
    );

    expect(steered).toEqual({ success: true, data: { queued: false, steered: true } });
    expect(h.agent.extMethod).toHaveBeenCalledWith('_session/steering', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'son durum ne?' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    const state = rt.getSessionState('conv-1');
    expect(state.lifecycle).toBe('working');
    expect(state.queuedPrompts).toEqual([]);
    expect(await userTexts(rt)).toEqual(['work', 'son durum ne?']);

    turn.resolve({ stopReason: 'end_turn' });
    await waitForReady(rt);
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'promptRequired',
      async (h: Awaited<ReturnType<typeof launch>>['h']) =>
        h.agent.extMethod.mockResolvedValueOnce({ outcome: 'promptRequired' }),
    ],
    [
      'failed',
      async (h: Awaited<ReturnType<typeof launch>>['h']) =>
        h.agent.extMethod.mockResolvedValueOnce({ outcome: 'failed' }),
    ],
    [
      'a thrown request',
      async (h: Awaited<ReturnType<typeof launch>>['h']) =>
        h.agent.extMethod.mockRejectedValueOnce(new Error('boom')),
    ],
  ])('queues the message when the agent answers with %s', async (_label, arrange) => {
    const { h, rt, turn } = await launch();
    await rt.sendPrompt('conv-1', { text: 'work' });
    await arrange(h);

    const result = await rt.sendPrompt('conv-1', { text: 'later' }, 'steer');

    expect(result).toEqual({ success: true, data: { queued: true } });
    expect(rt.getSessionState('conv-1').queuedPrompts).toMatchObject([{ text: 'later' }]);

    h.agent.prompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
    turn.resolve({ stopReason: 'end_turn' });
    await waitForReady(rt);
    expect(h.agent.prompt).toHaveBeenCalledTimes(2);
    expect(h.agent.prompt).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'later' }],
    });
  });

  it('acts like auto when the agent does not advertise steering', async () => {
    const { h, rt } = await launch({ advertise: false });
    await rt.sendPrompt('conv-1', { text: 'work' });
    expect(rt.getSessionState('conv-1').supportsSteering).toBeUndefined();

    const result = await rt.sendPrompt('conv-1', { text: 'later' }, 'steer');

    expect(result).toEqual({ success: true, data: { queued: true } });
    expect(h.agent.extMethod).not.toHaveBeenCalled();
  });

  it('starts a normal prompt when no turn is running', async () => {
    const { h, rt } = await launch();

    const result = await rt.sendPrompt('conv-1', { text: 'hello' }, 'steer');

    expect(result).toEqual({ success: true, data: { queued: false } });
    expect(h.agent.extMethod).not.toHaveBeenCalled();
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
  });
});

async function waitForReady(rt: AcpRuntime): Promise<void> {
  await vi.waitFor(() => expect(rt.getSessionState('conv-1').lifecycle).toBe('ready'));
}
