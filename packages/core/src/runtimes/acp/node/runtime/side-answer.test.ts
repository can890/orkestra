import { isOk } from '@orkestra/shared';
import { deferred } from '@orkestra/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SIDE_ID = '8a7f8c2e-1d63-4a8e-9c2c-9f3a0f0a0001';
const SIDE_ID_2 = '8a7f8c2e-1d63-4a8e-9c2c-9f3a0f0a0002';

const sideChunk = (text: string) => ({
  sessionId: 'side-1',
  update: {
    sessionUpdate: 'agent_message_chunk' as const,
    content: { type: 'text' as const, text },
  },
});

async function launch() {
  const main = new FakeAcpAgent();
  const side = new FakeAcpAgent();
  side.newSession = vi.fn().mockResolvedValue({ sessionId: 'side-1' });
  let connects = 0;
  const h = makeAcpHarness({
    acpBehavior: {
      buildSpawn: () => ({ command: '/fake/agent', args: [], env: {} }),
      connect: (io, toClient) => (connects++ === 0 ? main : side).behavior.connect(io, toClient),
    },
  });
  const rt = new AcpRuntime({ ...h.deps, lifecycle: { activationDrainTimeoutMs: 20 } });
  const started = await rt.launchSession(makeStartInput({ conversationId: 'conv-1' }));
  expect(isOk(started)).toBe(true);
  const turn = deferred<{ stopReason: 'end_turn' }>();
  main.prompt.mockReturnValueOnce(turn.promise);
  await rt.sendPrompt('conv-1', { text: 'uzun işe başla' });
  return { h, rt, main, side, turn };
}

async function transcriptTexts(rt: AcpRuntime): Promise<string[]> {
  const history = await rt.loadHistory('conv-1');
  const active = rt.getSessionState('conv-1').transcript?.activeTurn;
  const turns = [...(isOk(history) ? history.data.turns : []), ...(active ? [active] : [])];
  return turns
    .flatMap((t) => t.items)
    .filter((i) => i.kind === 'message')
    .map((i) => `${i.role}${i.side ? `*${i.side.status}` : ''}:${i.text}`);
}

describe('side answer while a turn runs', () => {
  it('streams the answer into the transcript and leaves the main session untouched', async () => {
    const { h, rt, main, side, turn } = await launch();
    expect(rt.getSessionState('conv-1').supportsSideAnswer).toBe(true);
    const gate = deferred<void>();
    side.prompt = vi.fn(async () => {
      await side.capturedClient!.sessionUpdate(sideChunk('Üç dosya '));
      await gate.promise;
      await side.capturedClient!.sessionUpdate(sideChunk('düzenlendi.'));
      return { stopReason: 'end_turn' as const };
    });
    const before = rt.getSessionState('conv-1');

    const sent = await rt.sendPrompt('conv-1', { text: 'son durum ne?' }, 'side', SIDE_ID);

    expect(sent).toEqual({ success: true, data: { queued: false, sideAnswer: true } });
    await vi.waitFor(async () =>
      expect(await transcriptTexts(rt)).toContain('assistant*running:Üç dosya ')
    );
    gate.resolve();
    await vi.waitFor(async () =>
      expect(await transcriptTexts(rt)).toContain('assistant*done:Üç dosya düzenlendi.')
    );

    const texts = await transcriptTexts(rt);
    expect(texts).toEqual([
      'user:uzun işe başla',
      'user*done:son durum ne?',
      'assistant*done:Üç dosya düzenlendi.',
    ]);
    const prompt = (
      side.prompt.mock.calls[0] as unknown as [{ prompt: Array<{ text: string }> }]
    )[0].prompt[0].text;
    expect(prompt).toContain('Kullanıcı: uzun işe başla');
    expect(prompt.endsWith('Kullanıcının sorusu: son durum ne?')).toBe(true);
    expect(side.newSession).toHaveBeenCalledWith({ cwd: '/tmp/workspace', mcpServers: [] });
    await vi.waitFor(() => expect(side.closeSession).toHaveBeenCalledWith({ sessionId: 'side-1' }));
    await vi.waitFor(() => expect(h.children[1].kill).toHaveBeenCalled());

    const after = rt.getSessionState('conv-1');
    expect(after.lifecycle).toBe('working');
    expect(after.activeTurnId).toBe(before.activeTurnId);
    expect(after.queuedPrompts).toEqual([]);
    expect(main.prompt).toHaveBeenCalledTimes(1);
    expect(main.cancel).not.toHaveBeenCalled();
    expect(h.children[0].kill).not.toHaveBeenCalled();

    turn.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(rt.getSessionState('conv-1').lifecycle).toBe('ready'));
  });

  it('runs one side answer at a time per conversation', async () => {
    const { h, rt, side, turn } = await launch();
    const first = deferred<void>();
    side.prompt = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first.promise;
        return { stopReason: 'end_turn' as const };
      })
      .mockResolvedValue({ stopReason: 'end_turn' as const });

    await rt.sendPrompt('conv-1', { text: 'birinci?' }, 'side', SIDE_ID);
    await rt.sendPrompt('conv-1', { text: 'ikinci?' }, 'side', SIDE_ID_2);
    await vi.waitFor(() => expect(side.prompt).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));

    expect(h.children).toHaveLength(2);
    expect(await transcriptTexts(rt)).toContain('assistant*pending:Yan cevap sırada…');

    first.resolve();
    await vi.waitFor(() => expect(side.prompt).toHaveBeenCalledTimes(2));
    expect(h.children).toHaveLength(3);
    turn.resolve({ stopReason: 'end_turn' });
  });

  it('tears the transient session down when the conversation is disposed mid-answer', async () => {
    const { h, rt, side } = await launch();
    side.prompt = vi.fn(() => new Promise(() => {}));
    await rt.sendPrompt('conv-1', { text: 'son durum?' }, 'side', SIDE_ID);
    await vi.waitFor(() => expect(side.prompt).toHaveBeenCalled());

    await rt.terminateSession('conv-1');

    await vi.waitFor(() => expect(h.children[1].kill).toHaveBeenCalled());
    expect(side.closeSession).toHaveBeenCalled();
    await rt.dispose();
  });

  it('shows the failure in the answer row when the transient session errors', async () => {
    const { rt, side, turn } = await launch();
    side.prompt = vi.fn().mockRejectedValue(new Error('kota doldu'));

    await rt.sendPrompt('conv-1', { text: 'son durum?' }, 'side', SIDE_ID);

    await vi.waitFor(async () =>
      expect(await transcriptTexts(rt)).toContain('assistant*error:Yan cevap alınamadı: kota doldu')
    );
    expect(rt.getSessionState('conv-1').lifecycle).toBe('working');
    turn.resolve({ stopReason: 'end_turn' });
  });

  it("acts like 'auto' when no turn runs or attachments are present", async () => {
    const { h, rt, main, turn } = await launch();
    const withAttachment = await rt.sendPrompt(
      'conv-1',
      { text: 'bak', attachments: [{ type: 'attachment', id: 'a', mimeType: 'image/png' }] },
      'side'
    );
    expect(withAttachment).toEqual({ success: true, data: { queued: true } });
    expect(h.children).toHaveLength(1);

    main.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    turn.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(rt.getSessionState('conv-1').lifecycle).toBe('ready'));
    await vi.waitFor(() => expect(rt.getSessionState('conv-1').lifecycle).toBe('ready'));

    const idle = await rt.sendPrompt('conv-1', { text: 'şimdi' }, 'side');
    expect(idle).toEqual({ success: true, data: { queued: false } });
    expect(h.children).toHaveLength(1);
  });
});
