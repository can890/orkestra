import { describe, expect, it } from 'vitest';
import { AGENT_ACTIVITY_SETTLED_RETENTION_MS } from '../api/contract';
import {
  applyAgentSignal,
  applyStatusChange,
  clampText,
  createAgentActivityModel,
  orderEntries,
  pruneAgentActivity,
  targetStateForSignal,
  type AgentActivityContext,
  type AgentActivitySignal,
} from './agent-activity-model';

const CONTEXT: AgentActivityContext = {
  projectId: 'p1',
  taskId: 't1',
  title: 'Fix login',
  projectName: 'Orkestra',
  providerName: 'Claude',
};

function signal(
  type: AgentActivitySignal['type'],
  timestamp: number,
  payload: AgentActivitySignal['payload'] = {},
  conversationId = 'c1'
): AgentActivitySignal {
  return { type, conversationId, timestamp, payload };
}

describe('agent activity model: signal → state', () => {
  it('maps agent signals to activity states (approval vs question)', () => {
    expect(targetStateForSignal(signal('start', 1))).toBe('working');
    expect(targetStateForSignal(signal('stop', 1))).toBe('finished');
    expect(targetStateForSignal(signal('error', 1))).toBe('failed');
    expect(
      targetStateForSignal(signal('notification', 1, { notificationType: 'permission_prompt' }))
    ).toBe('needs-approval');
    expect(
      targetStateForSignal(signal('notification', 1, { notificationType: 'elicitation_dialog' }))
    ).toBe('asked-question');
    expect(
      targetStateForSignal(signal('notification', 1, { notificationType: 'idle_prompt' }))
    ).toBe('asked-question');
    expect(
      targetStateForSignal(signal('notification', 1, { notificationType: 'auth_success' }))
    ).toBeNull();
  });
});

describe('agent activity model: transitions → alert decisions', () => {
  it('walks a full turn: working (silent) → approval (alert) → working (silent) → finished (alert)', () => {
    const model = createAgentActivityModel();
    const start = applyAgentSignal(model, signal('start', 1_000), CONTEXT);
    expect(start).toEqual([expect.objectContaining({ kind: 'upsert', alert: false })]);
    expect(start[0]!.kind === 'upsert' && start[0]!.entry).toMatchObject({
      state: 'working',
      startedAt: 1_000,
      title: 'Fix login',
      projectName: 'Orkestra',
      providerName: 'Claude',
      revision: 1,
    });

    const approval = applyAgentSignal(
      model,
      signal('notification', 2_000, {
        notificationType: 'permission_prompt',
        message: 'Run   `rm -rf build`?',
      }),
      CONTEXT
    );
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ kind: 'upsert', alert: true });
    expect(approval[0]!.kind === 'upsert' && approval[0]!.entry).toMatchObject({
      state: 'needs-approval',
      preview: 'Run `rm -rf build`?',
      startedAt: 1_000,
    });

    const resumed = applyAgentSignal(model, signal('start', 3_000), CONTEXT);
    expect(resumed[0]).toMatchObject({ kind: 'upsert', alert: false });

    const finished = applyAgentSignal(
      model,
      signal('stop', 9_000, { lastAssistantMessage: 'All tests pass.' }),
      CONTEXT
    );
    expect(finished[0]).toMatchObject({ kind: 'upsert', alert: true });
    expect(finished[0]!.kind === 'upsert' && finished[0]!.entry).toMatchObject({
      state: 'finished',
      preview: 'All tests pass.',
      stateChangedAt: 9_000,
      revision: 4,
    });
  });

  it('does not re-alert for a repeated waiting state or a duplicate stop', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('start', 1_000), CONTEXT);
    const prompt = { notificationType: 'permission_prompt' };
    expect(applyAgentSignal(model, signal('notification', 2_000, prompt), CONTEXT)).toHaveLength(1);
    expect(applyAgentSignal(model, signal('notification', 2_500, prompt), CONTEXT)).toEqual([]);
    expect(applyAgentSignal(model, signal('stop', 5_000), CONTEXT)).toHaveLength(1);
    // Kanca + köprü aynı turu iki kez bildirebilir.
    expect(applyAgentSignal(model, signal('stop', 5_400), CONTEXT)).toEqual([]);
    // Belirgin biçimde daha yeni bir "stop" yeni bir tur sonucudur.
    const later = applyAgentSignal(model, signal('stop', 60_000), CONTEXT);
    expect(later[0]).toMatchObject({ kind: 'upsert', alert: true });
  });

  it('ignores stale (out of order) signals and irrelevant notifications', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('stop', 10_000), CONTEXT);
    expect(applyAgentSignal(model, signal('start', 9_000), CONTEXT)).toEqual([]);
    expect(
      applyAgentSignal(
        model,
        signal('notification', 11_000, { notificationType: 'auth_success' }),
        CONTEXT
      )
    ).toEqual([]);
    expect(model.entries.get('c1')?.state).toBe('finished');
  });

  it('marks failures as alerts with the error message as preview', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('start', 1), CONTEXT);
    const failed = applyAgentSignal(
      model,
      signal('error', 2, { message: 'Rate limited' }),
      CONTEXT
    );
    expect(failed[0]).toMatchObject({
      kind: 'upsert',
      alert: true,
      entry: { state: 'failed', preview: 'Rate limited' },
    });
  });
});

describe('agent activity model: status hook', () => {
  it('silently removes cancelled/closed work but keeps settled results', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('start', 1), CONTEXT);
    const removed = applyStatusChange(model, { conversationId: 'c1', status: 'idle', at: 2 }, null);
    expect(removed).toEqual([{ kind: 'remove', conversationId: 'c1', revision: 2 }]);

    applyAgentSignal(model, signal('stop', 3, {}, 'c2'), CONTEXT);
    expect(applyStatusChange(model, { conversationId: 'c2', status: 'idle', at: 4 }, null)).toEqual(
      []
    );
    expect(model.entries.get('c2')?.state).toBe('finished');
  });

  it('seeds unknown working/awaiting conversations silently (startup cache)', () => {
    const model = createAgentActivityModel();
    const seeded = applyStatusChange(
      model,
      { conversationId: 'c1', status: 'awaiting-input', at: 5 },
      CONTEXT
    );
    expect(seeded).toEqual([
      expect.objectContaining({
        kind: 'upsert',
        alert: false,
        entry: expect.objectContaining({ state: 'needs-approval' }),
      }),
    ]);
    // Var olan kayıt ezilmez (ayrıntılı tür agent:event'ten gelir).
    expect(
      applyStatusChange(model, { conversationId: 'c1', status: 'working', at: 6 }, CONTEXT)
    ).toEqual([]);
    // Bitti/hata durum kancasından değil, agent:event'ten türetilir.
    expect(
      applyStatusChange(model, { conversationId: 'c9', status: 'completed', at: 6 }, CONTEXT)
    ).toEqual([]);
  });
});

describe('agent activity model: retention and ordering', () => {
  it('prunes settled results after the retention window and caps the entry count', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('stop', 0, {}, 'old'), CONTEXT);
    applyAgentSignal(model, signal('start', 0, {}, 'running'), CONTEXT);
    const now = AGENT_ACTIVITY_SETTLED_RETENTION_MS + 1;
    const changes = pruneAgentActivity(model, now);
    expect(changes).toEqual([expect.objectContaining({ kind: 'remove', conversationId: 'old' })]);
    expect([...model.entries.keys()]).toEqual(['running']);

    for (let i = 0; i < 5; i += 1)
      applyAgentSignal(model, signal('stop', now + i, {}, `s${i}`), CONTEXT);
    pruneAgentActivity(model, now + 10, 3);
    // Süren iş korunur, en eski sonuçlar düşer.
    expect([...model.entries.keys()].sort()).toEqual(['running', 's3', 's4']);
  });

  it('orders active work first, newest first within each group', () => {
    const model = createAgentActivityModel();
    applyAgentSignal(model, signal('stop', 50, {}, 'done-new'), CONTEXT);
    applyAgentSignal(model, signal('stop', 10, {}, 'done-old'), CONTEXT);
    applyAgentSignal(model, signal('start', 5, {}, 'work-old'), CONTEXT);
    applyAgentSignal(model, signal('start', 20, {}, 'work-new'), CONTEXT);
    expect(orderEntries([...model.entries.values()]).map((e) => e.conversationId)).toEqual([
      'work-new',
      'work-old',
      'done-new',
      'done-old',
    ]);
  });

  it('clamps labels and previews to one bounded line', () => {
    expect(clampText('a\n\n b\tc\u0007', 50)).toBe('a b c');
    expect(clampText('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(clampText(undefined, 10)).toBe('');
  });
});
