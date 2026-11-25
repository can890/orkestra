import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Serializable } from '@orkestra/shared';
import { createManualClock, deferred } from '@orkestra/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '#runtimes/acp/node/acp-test-support';
import { emptyRetainedPresentation } from '#runtimes/acp/node/state/live-models';
import type { ConversationLifecycleReporter } from '#services/conversation-reports/node';
import { createMemorySessionIntentStore } from '#services/session-intents/api';
import { AcpRuntime } from './runtime';

// Bir sohbet oluşturulup ilk istem hiç gönderilmeden ajan oturumu kapatılırsa sağlayıcı (ör. Claude
// Code) oturum dosyasını hiç yazmaz; kayıtlı oturum `loadSession` ile bir daha açılamaz.
function reporterSpy() {
  return {
    sessionStarted: vi.fn(),
    providerSessionId: vi.fn(),
    activity: vi.fn(),
    sessionEnded: vi.fn(),
  } satisfies ConversationLifecycleReporter;
}

function sessionNotFound(sessionId: string) {
  return RequestError.resourceNotFound(sessionId);
}

// Masaüstü, her açılışta kendi kayıtlı oturum kimliğini (ilk `newSession` sonucunu) gönderir.
function hostInput(conversationId: string, sessionId: string | null) {
  return makeStartInput({ conversationId, sessionId });
}

describe('ACP restoration of a session that never received a prompt', () => {
  it('starts a fresh session when the idle-evicted, never-prompted session is gone', async () => {
    const intents = createMemorySessionIntentStore();
    const reports = reporterSpy();
    const clock = createManualClock(0);
    const h = makeAcpHarness({
      clock,
      intents,
      conversationReports: reports,
      lifecycle: { session: { kind: 'idle-after', outputMs: 60_000 } },
    });
    const runtime = new AcpRuntime(h.deps);
    const conversationId = 'empty-chat';
    try {
      // Sohbet açılır: geçmiş yüklemesi yeni bir oturum yaratır, istem gönderilmez.
      await runtime.attachSession(hostInput(conversationId, null));
      expect((await runtime.loadHistory(conversationId)).success).toBe(true);
      expect(h.agent.newSession).toHaveBeenCalledOnce();
      expect(intents.snapshot()[0]).toMatchObject({
        sessionId: 'session-1',
        payload: { sessionId: 'session-1', unpromptedSessionId: 'session-1' },
      });

      // Hiç girdi/çıktı görmeyen oturum, boşta kalma süresi açılışından itibaren dolunca askıya alınır.
      await clock.advanceBy(60_001);
      await runtime.manager.sweepNow();
      expect(runtime.manager.inspect().running).toEqual([]);
      expect(intents.snapshot()[0]).toMatchObject({ status: 'suspended', suspendedCause: 'idle' });

      // Claude Code oturumu diske hiç yazmadığı için geri yükleme "Resource not found" döner.
      h.agent.loadSession.mockRejectedValueOnce(sessionNotFound('session-1'));
      h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-2' });
      await runtime.attachSession(hostInput(conversationId, 'session-1'));
      const reopened = await runtime.loadHistory(conversationId);

      expect(reopened).toMatchObject({ success: true, data: { turns: [] } });
      expect(reopened.success && reopened.data.unavailable).toBeFalsy();
      expect(h.agent.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1' })
      );
      expect(h.agent.newSession).toHaveBeenCalledTimes(2);
      expect(reports.sessionStarted).toHaveBeenLastCalledWith({
        conversationId,
        providerSessionId: 'session-2',
        resumeOutcome: 'replaced-by-new',
      });
      expect(intents.snapshot()[0]).toMatchObject({
        sessionId: 'session-2',
        payload: { sessionId: 'session-2', unpromptedSessionId: 'session-2' },
      });

      // Kullanıcı doğrudan yazabilir; istem yeni oturuma gider ve kanıt düşer.
      expect((await runtime.sendPrompt(conversationId, { text: 'merhaba' })).success).toBe(true);
      expect(h.agent.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-2' })
      );
      await vi.waitFor(() =>
        expect(intents.snapshot()[0]?.payload).not.toHaveProperty('unpromptedSessionId')
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps the proof across a worker restart and replaces the session on the next open', async () => {
    const intents = createMemorySessionIntentStore();
    const first = makeAcpHarness({ intents });
    const before = new AcpRuntime(first.deps);
    const conversationId = 'empty-chat-restart';
    await before.attachSession(hostInput(conversationId, null));
    expect((await before.loadHistory(conversationId)).success).toBe(true);
    await before.dispose();

    const second = makeAcpHarness({ intents });
    const after = new AcpRuntime(second.deps);
    try {
      await after.reconcile();
      expect(intents.snapshot()[0]?.payload).toMatchObject({ unpromptedSessionId: 'session-1' });
      second.agent.loadSession.mockRejectedValueOnce(sessionNotFound('session-1'));
      second.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-2' });
      await after.attachSession(hostInput(conversationId, 'session-1'));

      expect(await after.loadHistory(conversationId)).toMatchObject({ success: true });
      expect(second.agent.newSession).toHaveBeenCalledOnce();
      expect(intents.snapshot()[0]).toMatchObject({ sessionId: 'session-2' });
    } finally {
      await after.dispose();
    }
  });

  it('never replaces a session that received a prompt, even when the provider cannot find it', async () => {
    const intents = createMemorySessionIntentStore();
    const h = makeAcpHarness({ intents });
    const runtime = new AcpRuntime(h.deps);
    const conversationId = 'chat-with-history';
    try {
      await runtime.attachSession(hostInput(conversationId, null));
      expect((await runtime.loadHistory(conversationId)).success).toBe(true);
      expect((await runtime.sendPrompt(conversationId, { text: 'merhaba' })).success).toBe(true);
      await vi.waitFor(() =>
        expect(intents.snapshot()[0]?.payload).not.toHaveProperty('unpromptedSessionId')
      );
      await runtime.stopSession(conversationId);

      h.agent.loadSession.mockRejectedValue(sessionNotFound('session-1'));
      await runtime.attachSession(hostInput(conversationId, 'session-1'));
      const reopened = await runtime.loadHistory(conversationId);

      expect(reopened).toMatchObject({
        success: false,
        error: {
          type: 'invalid_state',
          message: 'Sohbet yeniden açılamadı. Kayıtlı oturum korundu. Tekrar deneyin.',
        },
      });
      expect(h.agent.newSession).toHaveBeenCalledOnce();
      expect(intents.snapshot()[0]).toMatchObject({
        sessionId: 'session-1',
        payload: { sessionId: 'session-1' },
      });
    } finally {
      await runtime.dispose();
    }
  });

  describe('after the user confirms continuing with a new session', () => {
    async function chatWithHistory(conversationId: string) {
      const intents = createMemorySessionIntentStore();
      const reports = reporterSpy();
      const h = makeAcpHarness({ intents, conversationReports: reports });
      const runtime = new AcpRuntime(h.deps);
      await runtime.attachSession(hostInput(conversationId, null));
      expect((await runtime.loadHistory(conversationId)).success).toBe(true);
      expect((await runtime.sendPrompt(conversationId, { text: 'merhaba' })).success).toBe(true);
      await vi.waitFor(() =>
        expect(intents.snapshot()[0]?.payload).not.toHaveProperty('unpromptedSessionId')
      );
      await runtime.stopSession(conversationId);
      return { intents, reports, h, runtime };
    }
    const consent = (conversationId: string) => ({
      ...hostInput(conversationId, 'session-1'),
      replaceUnloadableSession: true as const,
    });

    it('marks a definite "not found" so the client can offer it, then replaces on consent', async () => {
      const conversationId = 'dead-chat';
      const { intents, reports, h, runtime } = await chatWithHistory(conversationId);
      try {
        h.agent.loadSession.mockRejectedValue(sessionNotFound('session-1'));
        await runtime.attachSession(hostInput(conversationId, 'session-1'));
        expect(await runtime.loadHistory(conversationId)).toMatchObject({
          success: false,
          error: { type: 'invalid_state', reason: 'session_not_found' },
        });
        expect(h.agent.newSession).toHaveBeenCalledOnce();

        h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-2' });
        await runtime.attachSession(consent(conversationId));
        expect(await runtime.loadHistory(conversationId)).toMatchObject({
          success: true,
          data: { turns: [] },
        });
        expect(h.agent.newSession).toHaveBeenCalledTimes(2);
        expect(reports.sessionStarted).toHaveBeenLastCalledWith({
          conversationId,
          providerSessionId: 'session-2',
          resumeOutcome: 'replaced-by-new',
        });
        expect(intents.snapshot()[0]).toMatchObject({ sessionId: 'session-2' });
        // The one-shot request never reaches the durable intent.
        expect(intents.snapshot()[0]?.payload).not.toHaveProperty('replaceUnloadableSession');
      } finally {
        await runtime.dispose();
      }
    });

    it('never replaces a session that still loads', async () => {
      const conversationId = 'alive-chat';
      const { h, runtime } = await chatWithHistory(conversationId);
      try {
        await runtime.attachSession(consent(conversationId));
        expect((await runtime.loadHistory(conversationId)).success).toBe(true);
        expect(h.agent.loadSession).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-1' })
        );
        expect(h.agent.newSession).toHaveBeenCalledOnce();
      } finally {
        await runtime.dispose();
      }
    });

    it('never replaces on a transient failure, and the consent does not outlive that attempt', async () => {
      const conversationId = 'flaky-chat';
      const { intents, h, runtime } = await chatWithHistory(conversationId);
      try {
        h.agent.loadSession.mockRejectedValueOnce(new Error('agent process is restarting'));
        await runtime.attachSession(consent(conversationId));
        const failed = await runtime.loadHistory(conversationId);
        expect(failed).toMatchObject({ success: false, error: { type: 'invalid_state' } });
        expect(!failed.success && 'reason' in failed.error && failed.error.reason).toBeFalsy();

        // A later definite "not found" without a new confirmation still keeps the session.
        h.agent.loadSession.mockRejectedValue(sessionNotFound('session-1'));
        expect(await runtime.loadHistory(conversationId)).toMatchObject({
          success: false,
          error: { type: 'invalid_state', reason: 'session_not_found' },
        });
        expect(h.agent.newSession).toHaveBeenCalledOnce();
        expect(intents.snapshot()[0]).toMatchObject({ sessionId: 'session-1' });
      } finally {
        await runtime.dispose();
      }
    });
  });

  it('protects a saved session without the never-prompted proof (older intents)', async () => {
    const intents = createMemorySessionIntentStore();
    const conversationId = 'legacy-intent';
    await intents.saveActive({
      conversationId,
      sessionId: 'saved-session',
      payload: {
        version: '1',
        conversationId,
        providerId: 'claude',
        cwd: '/tmp/workspace',
        sessionId: 'saved-session',
        configured: { model: null, modeId: null, effort: null, collaborationMode: null },
        presentation: emptyRetainedPresentation({
          model: null,
          modeId: null,
          effort: null,
          collaborationMode: null,
        }),
      } as unknown as Serializable,
    });
    await intents.markSuspended(conversationId, 'idle');
    const h = makeAcpHarness({ intents });
    const runtime = new AcpRuntime(h.deps);
    try {
      await runtime.reconcile();
      h.agent.loadSession.mockRejectedValue(sessionNotFound('saved-session'));
      await runtime.attachSession(hostInput(conversationId, 'saved-session'));

      expect(await runtime.loadHistory(conversationId)).toMatchObject({
        success: false,
        error: { type: 'invalid_state' },
      });
      expect(h.agent.newSession).not.toHaveBeenCalled();
      expect(intents.snapshot()[0]).toMatchObject({ sessionId: 'saved-session' });
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps a never-prompted session when restoration fails for another reason', async () => {
    const intents = createMemorySessionIntentStore();
    const h = makeAcpHarness({ intents });
    const runtime = new AcpRuntime(h.deps);
    const conversationId = 'empty-chat-transient';
    try {
      await runtime.attachSession(hostInput(conversationId, null));
      expect((await runtime.loadHistory(conversationId)).success).toBe(true);
      await runtime.stopSession(conversationId);

      h.agent.loadSession.mockRejectedValueOnce(new Error('agent process is restarting'));
      await runtime.attachSession(hostInput(conversationId, 'session-1'));

      expect(await runtime.loadHistory(conversationId)).toMatchObject({
        success: false,
        error: { type: 'invalid_state' },
      });
      expect(h.agent.newSession).toHaveBeenCalledOnce();
      expect(intents.snapshot()[0]).toMatchObject({
        sessionId: 'session-1',
        payload: { unpromptedSessionId: 'session-1' },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('routes updates the agent sends while a new session is still being configured', async () => {
    const warn = vi.fn();
    const h = makeAcpHarness({ lifecycle: { session: { kind: 'idle-after', outputMs: 60_000 } } });
    h.deps.logger = { ...h.deps.logger, warn };
    const runtime = new AcpRuntime(h.deps);
    const conversationId = 'commands-before-route';
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-1',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'bypassPermissions', name: 'Bypass' },
          ],
        },
      ],
    });
    const modeApplied = deferred<Record<string, never>>();
    h.agent.setSessionConfigOption.mockImplementationOnce(async () => {
      // Claude Code duyurusunu `newSession` yanıtından hemen sonra, mod ayarlanırken gönderir.
      await h.client().sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review', description: 'Review changes' }],
        } as SessionUpdate,
      });
      return modeApplied.promise;
    });
    try {
      await runtime.attachSession({
        ...hostInput(conversationId, null),
        modeId: 'bypassPermissions',
      });
      const opening = runtime.loadHistory(conversationId);
      await vi.waitFor(() => expect(h.agent.setSessionConfigOption).toHaveBeenCalledOnce());
      modeApplied.resolve({});
      expect((await opening).success).toBe(true);

      expect(warn).not.toHaveBeenCalledWith(
        'SessionManager: sessionUpdate for unknown sessionId',
        expect.anything()
      );
      // Görülen çıktı, açılan sohbeti ilk süpürmede askıya alınmaktan korur.
      await runtime.manager.sweepNow();
      expect(runtime.manager.inspect().running).toEqual([conversationId]);
    } finally {
      await runtime.dispose();
    }
  });
});
