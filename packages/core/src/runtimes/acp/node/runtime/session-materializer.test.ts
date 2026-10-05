import { createScope, type Scope } from '@orkestra/shared/concurrency';
import { deferred } from '@orkestra/shared/testing';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  claudeLiveModelOptions,
  claudeModelConfigOption,
  makeAcpHarness,
  makeStartInput,
  recordedClaudeLiveModelOptions,
} from '#runtimes/acp/node/acp-test-support';
import type { AcpConnectionEntry, AcpConnectionSource } from '#runtimes/acp/node/connection/source';
import type { ConversationHandle } from './conversation-handle';
import type { ConfigDimension, ConfigOverrides, SessionRecord } from './conversation-types';
import { SessionMaterializer, type SessionMaterializerCallbacks } from './session-materializer';

describe('SessionMaterializer', () => {
  it('preserves the existing session after a failed load and cleans up its provisional route', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession.mockRejectedValueOnce(new Error('session file is gone'));
    const setup = materializerHarness(h, { effort: 'high', collaborationMode: 'plan' });
    const result = await setup.materializer.materialize(
      setup.entry,
      setup.entry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );
    expect(result).toMatchObject({ success: false, error: { type: 'invalid_state' } });
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(setup.entry.descriptor.sessionId).toBe('retained-session');
    expect(setup.entry.configOverrides).toEqual({ effort: 'high', collaborationMode: 'plan' });
    expect(setup.discarded).toHaveLength(1);
    expect(setup.loading).toEqual([]);
    await setup.scope.dispose();
    expect(setup.release).toHaveBeenCalledOnce();
  });

  it('logs the sanitized provider explanation carried in JSON-RPC error data', async () => {
    const h = makeAcpHarness();
    const warn = vi.fn();
    h.deps.logger = { ...h.deps.logger, warn };
    const secret = `ghp_${'a'.repeat(36)}`;
    h.agent.loadSession.mockRejectedValueOnce(
      Object.assign(new Error('Internal error'), {
        code: -32600,
        data: `no rollout found; token: ${secret}`,
      })
    );
    const setup = materializerHarness(h);
    try {
      await setup.materializer.materialize(
        setup.entry,
        setup.entry.descriptor,
        1,
        setup.scope,
        setup.controller.signal
      );
      expect(warn).toHaveBeenCalledWith(
        'SessionMaterializer: failed to restore existing session',
        expect.objectContaining({
          sessionId: 'retained-session',
          operation: 'loadSession',
          code: -32600,
          providerMessage: expect.stringContaining('no rollout found'),
        })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      await setup.scope.dispose();
    }
  });

  it('loads an existing session without creating a replacement', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession.mockResolvedValueOnce({});
    const setup = materializerHarness(h);

    const result = await setup.materializer.materialize(
      setup.entry,
      setup.entry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.record.cell.acpSessionId).toBe('retained-session');
    expect(result.data.record.resumeOutcome).toBe('loaded');
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(setup.loading).toEqual([]);
    expect(setup.routes).toContainEqual({
      processOwner: 'claude:/tmp/workspace:1',
      sessionId: 'retained-session',
      conversationId: 'conv-materializer',
    });

    await setup.scope.dispose();
  });

  it('rejects a late completion after the caller aborts and invalidates the conversation', async () => {
    const h = makeAcpHarness();
    h.agent.newSession = vi.fn(() => new Promise<never>(() => {}));
    const setup = materializerHarness(h, {}, { sessionId: null });

    const pending = setup.materializer.materialize(
      setup.entry,
      setup.entry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );
    await vi.waitFor(() => expect(h.agent.newSession).toHaveBeenCalledTimes(1));
    setup.current.value = false;
    setup.controller.abort(new Error('conversation killed'));

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: { type: 'conversation_not_found' },
    });
    await setup.scope.dispose();
  });

  it('serializes provider load handshakes on one process generation', async () => {
    const h = makeAcpHarness();
    const firstLoad = deferred<Record<string, never>>();
    const secondLoad = deferred<Record<string, never>>();
    h.agent.loadSession
      .mockImplementationOnce(async () => firstLoad.promise)
      .mockImplementationOnce(async () => secondLoad.promise);
    const setup = materializerHarness(h);
    const secondInput = makeStartInput({
      conversationId: 'conv-materializer-2',
      sessionId: 'retained-session-2',
    });
    const secondEntry = {
      conversationId: secondInput.conversationId,
      descriptor: secondInput,
      configOverrides: {},
    } as ConversationHandle;

    const first = setup.materializer.materialize(
      setup.entry,
      setup.entry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );
    await vi.waitFor(() => expect(h.agent.loadSession).toHaveBeenCalledTimes(1));
    const second = setup.materializer.materialize(
      secondEntry,
      secondEntry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );
    await Promise.resolve();

    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(setup.loading).toEqual(['conv-materializer']);
    firstLoad.resolve({});
    await first;
    await vi.waitFor(() => expect(h.agent.loadSession).toHaveBeenCalledTimes(2));
    expect(setup.loading).toEqual(['conv-materializer-2']);
    secondLoad.resolve({});
    await second;
    await setup.scope.dispose();
  });

  it('does not serialize new-session requests that need no provisional routing', async () => {
    const h = makeAcpHarness();
    const firstNew = deferred<{ sessionId: string }>();
    const secondNew = deferred<{ sessionId: string }>();
    h.agent.newSession
      .mockImplementationOnce(async () => firstNew.promise)
      .mockImplementationOnce(async () => secondNew.promise);
    const setup = materializerHarness(h, {}, { sessionId: null });
    const secondInput = makeStartInput({
      conversationId: 'conv-materializer-2',
      sessionId: null,
    });
    const secondEntry = {
      conversationId: secondInput.conversationId,
      descriptor: secondInput,
      configOverrides: {},
    } as ConversationHandle;

    const first = setup.materializer.materialize(
      setup.entry,
      setup.entry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );
    const second = setup.materializer.materialize(
      secondEntry,
      secondEntry.descriptor,
      1,
      setup.scope,
      setup.controller.signal
    );

    await vi.waitFor(() => expect(h.agent.newSession).toHaveBeenCalledTimes(2));
    firstNew.resolve({ sessionId: 'new-session-1' });
    secondNew.resolve({ sessionId: 'new-session-2' });
    await Promise.all([first, second]);
    await setup.scope.dispose();
  });

  describe('retained Claude model selections', () => {
    // Model pickers store Claude catalog ids; Claude Code offers the same models under aliases.
    it.each([
      ['claude-sonnet-5-5', 'sonnet'],
      ['claude-opus-5-5', 'opus[1m]'],
      // The Orkestra conductor's automatic choice: the strongest current Claude model.
      ['claude-fable-5-1', 'fable'],
    ])('applies %s to a new session as its live option %s', async (requested, live) => {
      const h = makeAcpHarness();
      h.agent.newSession.mockResolvedValueOnce({
        sessionId: 'session-new',
        configOptions: [claudeModelConfigOption()],
      });
      const setup = materializerHarness(h, { model: requested }, { sessionId: null });
      try {
        const result = await setup.materialize();

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(h.agent.setSessionConfigOption).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'session-new',
          configId: 'model',
          value: live,
        });
        expect(result.data.record.clearedConfiguration).toEqual({});
        expect(result.data.record.resolvedConfiguration).toEqual({ model: live });
        expect(setup.entry.updateConfig).toHaveBeenCalledWith('model', live);
        expect(setup.entry.configOverrides).toEqual({ model: live });
      } finally {
        await setup.scope.dispose();
      }
    });

    it('applies Fable when the session lists it under its full id with a context hint', async () => {
      const h = makeAcpHarness();
      const options = claudeLiveModelOptions.map((option) =>
        option.id === 'fable' ? { ...option, id: 'claude-fable-5-1[1m]', name: 'Fable' } : option
      );
      h.agent.newSession.mockResolvedValueOnce({
        sessionId: 'session-new',
        configOptions: [claudeModelConfigOption(options)],
      });
      const setup = materializerHarness(h, { model: 'claude-fable-5-1' }, { sessionId: null });
      try {
        const result = await setup.materialize();

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(h.agent.setSessionConfigOption).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'session-new',
          configId: 'model',
          value: 'claude-fable-5-1[1m]',
        });
        expect(result.data.record.resolvedConfiguration).toEqual({
          model: 'claude-fable-5-1[1m]',
        });
      } finally {
        await setup.scope.dispose();
      }
    });

    it('applies the live option when an existing session is reopened', async () => {
      const h = makeAcpHarness();
      h.agent.loadSession.mockResolvedValueOnce({
        configOptions: [claudeModelConfigOption(claudeLiveModelOptions, 'opus[1m]')],
      });
      const setup = materializerHarness(h, { model: 'claude-sonnet-5-5', effort: 'high' });
      try {
        const result = await setup.materialize();

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(h.agent.setSessionConfigOption).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'retained-session',
          configId: 'model',
          value: 'sonnet',
        });
        // Effort has no catalog in this session: it is cleared, not resolved.
        expect(result.data.record.clearedConfiguration).toEqual({ effort: 'high' });
        expect(result.data.record.resolvedConfiguration).toEqual({ model: 'sonnet' });
      } finally {
        await setup.scope.dispose();
      }
    });

    it('applies an exact live option id unchanged', async () => {
      const h = makeAcpHarness();
      h.agent.newSession.mockResolvedValueOnce({
        sessionId: 'session-new',
        configOptions: [claudeModelConfigOption()],
      });
      const setup = materializerHarness(h, { model: 'opus[1m]' }, { sessionId: null });
      try {
        const result = await setup.materialize();

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(h.agent.setSessionConfigOption).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'session-new',
          configId: 'model',
          value: 'opus[1m]',
        });
        expect(result.data.record.resolvedConfiguration).toEqual({});
        expect(result.data.record.clearedConfiguration).toEqual({});
        expect(setup.entry.updateConfig).not.toHaveBeenCalled();
        expect(setup.entry.configOverrides).toEqual({ model: 'opus[1m]' });
      } finally {
        await setup.scope.dispose();
      }
    });

    it('reports a model the session does not offer as unsupported without failing', async () => {
      const h = makeAcpHarness();
      const warn = vi.fn();
      h.deps.logger = { ...h.deps.logger, warn };
      // The older session offers Sonnet 5 only: Sonnet 5.5 must not fall back to it.
      h.agent.newSession.mockResolvedValueOnce({
        sessionId: 'session-new',
        configOptions: [claudeModelConfigOption(recordedClaudeLiveModelOptions)],
      });
      const setup = materializerHarness(h, { model: 'claude-sonnet-5-5' }, { sessionId: null });
      try {
        const result = await setup.materialize();

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
        expect(result.data.record.clearedConfiguration).toEqual({ model: 'claude-sonnet-5-5' });
        expect(result.data.record.resolvedConfiguration).toEqual({});
        expect(setup.entry.clearConfig).toHaveBeenCalledWith('model');
        expect(warn).toHaveBeenCalledWith(
          'SessionMaterializer: retained selection is not offered, clearing',
          {
            conversationId: 'conv-materializer',
            providerId: 'claude',
            dimension: 'model',
            requested: 'claude-sonnet-5-5',
            available: ['default', 'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku'],
          }
        );
      } finally {
        await setup.scope.dispose();
      }
    });
  });
});

function materializerHarness(
  harness: ReturnType<typeof makeAcpHarness>,
  configOverrides: ConfigOverrides = {},
  inputOverrides: Parameters<typeof makeStartInput>[0] = {}
) {
  const input = makeStartInput({
    conversationId: 'conv-materializer',
    sessionId: 'retained-session',
    ...inputOverrides,
  });
  const entry = {
    conversationId: input.conversationId,
    descriptor: input,
    configOverrides,
    updateConfig: vi.fn((dimension: ConfigDimension, value: string) => {
      entry.configOverrides = { ...entry.configOverrides, [dimension]: value };
    }),
    clearConfig: vi.fn((dimension: ConfigDimension) => {
      const { [dimension]: _removed, ...remaining } = entry.configOverrides;
      entry.configOverrides = remaining;
    }),
    clearMode: vi.fn(),
  } as unknown as ConversationHandle & {
    updateConfig: Mock<ConversationHandle['updateConfig']>;
    clearConfig: Mock<ConversationHandle['clearConfig']>;
  };
  const connection: AcpConnectionEntry = {
    key: 'claude:/tmp/workspace',
    generation: 1,
    providerId: 'claude',
    cwd: '/tmp/workspace',
    env: input.env ?? {},
    normalize: (update) => update as never,
    agent: harness.agent,
    supportsLoadSession: true,
    mcpCapabilities: { http: false, sse: false },
  };
  const release = vi.fn(async () => {});
  const connections: AcpConnectionSource = {
    acquire: vi.fn(() => ({ ready: async () => connection, release })),
    peek: () => connection,
    invalidate: async () => {},
    dispose: async () => {},
  };
  const scope = createScope({ label: 'session-materializer-test' });
  const controller = new AbortController();
  const current = { value: true };
  const discarded: SessionRecord[] = [];
  const loading: string[] = [];
  const routes: Array<{
    processOwner: string;
    sessionId: string;
    conversationId: string;
  }> = [];
  const callbacks: SessionMaterializerCallbacks = {
    isCurrent: () => current.value,
    onRecordCreated: (record, recordScope) => ownRecord(record, recordScope),
    onRecordChanged: () => {},
    onRecordClosed: () => {},
    discardRecord: (record) => {
      discarded.push(record);
      record.cell.dispose();
    },
    registerRoute: (processOwner, sessionId, conversationId) => {
      routes.push({ processOwner, sessionId, conversationId });
    },
    beginLoad: (processOwner, sessionId, conversationId) => {
      routes.push({ processOwner, sessionId, conversationId });
      loading.push(conversationId);
      return () => {
        const index = loading.indexOf(conversationId);
        if (index >= 0) loading.splice(index, 1);
      };
    },
  };
  const materializer = new SessionMaterializer(
    {
      agentHost: harness.deps.agentHost,
      resolveAttachment: harness.deps.resolveAttachment,
      logger: harness.deps.logger,
    },
    connections,
    callbacks
  );

  return {
    materializer,
    entry,
    scope,
    controller,
    current,
    discarded,
    loading,
    routes,
    release,
    materialize: () =>
      materializer.materialize(entry, entry.descriptor, 1, scope, controller.signal),
  };
}

function ownRecord(record: SessionRecord, scope: Scope): void {
  scope.add(() => {
    record.machineStateBinding.dispose();
    record.cell.dispose();
  });
}
