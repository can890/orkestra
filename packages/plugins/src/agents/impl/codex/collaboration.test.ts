/**
 * Codex çoklu ajan araçlarının (codex-acp "legacy" satırları) alt ajan modeline çevrilmesi.
 * Olaylar codex-acp 1.12'nin ürettiği biçimi taklit eder; kimlikler ve metinler sentetiktir.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { enrichCodexUpdate } from './acp-enrich';

const ROOT = 'thread-root';
const A = 'thread-0000-aaaa';
const B = 'thread-0000-bbbb';

type Activity = 'started' | 'interacted' | 'interrupted' | 'completed';

function activity(
  id: string,
  kind: Activity,
  threadId: string,
  path: string,
  sessionUpdate: 'tool_call' | 'tool_call_update',
  status: 'in_progress' | 'completed'
): SessionUpdate {
  const verb = {
    started: 'Start',
    interacted: 'Interact with',
    interrupted: 'Interrupt',
    completed: 'Complete',
  }[kind];
  const name = path.split('/').at(-1);
  return {
    sessionUpdate,
    toolCallId: id,
    status,
    ...(sessionUpdate === 'tool_call' ? { title: `${verb} subagent ${name}`, kind: 'other' } : {}),
    rawInput: { agentThreadId: threadId, agentPath: path, activityKind: kind },
    _meta: { codex: { subagent: { threadId, path, activity: kind } } },
  } as unknown as SessionUpdate;
}

function collab(
  id: string,
  tool: string,
  sessionUpdate: 'tool_call' | 'tool_call_update',
  status: 'in_progress' | 'completed' | 'failed',
  fields: {
    receiverThreadIds?: string[];
    agentsStates?: Record<string, { status: string; message: string | null }>;
    prompt?: string | null;
    model?: string | null;
  } = {}
): SessionUpdate {
  const receiverThreadIds = fields.receiverThreadIds ?? [];
  return {
    sessionUpdate,
    toolCallId: id,
    title: tool,
    ...(sessionUpdate === 'tool_call' ? { kind: 'other' } : {}),
    status,
    rawInput: {
      prompt: fields.prompt ?? null,
      senderThreadId: ROOT,
      receiverThreadIds,
      agentsStates: fields.agentsStates ?? {},
      model: fields.model ?? null,
      reasoningEffort: null,
      status: status === 'in_progress' ? 'inProgress' : status,
    },
    _meta: { codex: { collaboration: { tool, senderThreadId: ROOT, receiverThreadIds } } },
  } as unknown as SessionUpdate;
}

function parser() {
  const p = new AcpTranscriptParser({
    conversationId: 'conv-codex-collab',
    enrich: enrichCodexUpdate,
  });
  p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'ajanları başlat' }, 1);
  return p;
}

function rows(p: AcpTranscriptParser): Array<Record<string, unknown>> {
  const turns = [...p.history, ...(p.activeTurn ? [p.activeTurn] : [])];
  const flatten = (items: readonly unknown[]): Array<Record<string, unknown>> =>
    items.flatMap((item) => {
      const record = item as Record<string, unknown>;
      const children = record.children as unknown[] | undefined;
      return [record, ...(children ? flatten(children) : [])];
    });
  return flatten(turns.flatMap((turn) => turn.items));
}

const row = (p: AcpTranscriptParser, toolCallId: string) =>
  rows(p).find((item) => item.toolCallId === toolCallId);

describe('Codex multi-agent tools (v2: spawn_agent, wait_agent, send_message, interrupt_agent)', () => {
  it('turns spawn_agent into a running sub-agent card even after the spawn call completes', () => {
    const p = parser();
    p.push(activity('call_a', 'started', A, '/root/mobile', 'tool_call', 'in_progress'), 2);
    p.push(activity('call_a', 'started', A, '/root/mobile', 'tool_call_update', 'completed'), 3);
    expect(p.agents).toEqual([
      expect.objectContaining({
        agentId: A,
        toolCallId: 'call_a',
        name: 'Mobile',
        status: 'running',
        provider: 'codex',
        detached: true,
      }),
    ]);
    expect(row(p, 'call_a')).toMatchObject({
      kind: 'spawn-subagent-tool-call',
      status: 'running',
      background: true,
    });
  });

  it('keeps a replayed start (reported completed) running until its real outcome is known', () => {
    const p = parser();
    p.push(activity('call_a', 'started', A, '/root/mobile', 'tool_call', 'completed'), 2);
    expect(p.agents[0]?.status).toBe('running');
  });

  it('runs two agents in parallel and names them in a wait row', () => {
    const p = parser();
    p.push(activity('call_a', 'started', A, '/root/mobile', 'tool_call', 'in_progress'), 2);
    p.push(activity('call_b', 'started', B, '/root/side_bar', 'tool_call', 'in_progress'), 2);
    p.push(collab('call_w', 'wait', 'tool_call', 'in_progress'), 3);
    p.push(collab('call_w', 'wait', 'tool_call_update', 'completed'), 4);
    expect(p.agents.map((agent) => [agent.name, agent.status])).toEqual([
      ['Mobile', 'running'],
      ['Side bar', 'running'],
    ]);
    expect(row(p, 'call_w')).toMatchObject({
      kind: 'unknown-tool-call',
      title: 'Alt ajanlar bekleniyor (2)',
      inputSummary: 'Mobile, Side bar',
      toolKind: null,
      status: 'done',
    });
  });

  it('marks an interrupted agent "interrupted" and labels the rows in Turkish', () => {
    const p = parser();
    p.push(activity('call_a', 'started', A, '/root/mobile', 'tool_call', 'in_progress'), 2);
    p.push(activity('call_m', 'interacted', A, '/root/mobile', 'tool_call', 'completed'), 3);
    p.push(activity('call_i', 'interrupted', A, '/root/mobile', 'tool_call', 'in_progress'), 4);
    expect(p.agents[0]?.status).toBe('running');
    p.push(
      activity('call_i', 'interrupted', A, '/root/mobile', 'tool_call_update', 'completed'),
      5
    );
    expect(p.agents[0]).toMatchObject({ status: 'failed', interrupted: true });
    expect(row(p, 'call_m')).toMatchObject({
      title: 'Alt ajana mesaj gönderildi',
      inputSummary: 'Mobile',
      toolKind: null,
    });
    expect(row(p, 'call_i')).toMatchObject({
      title: 'Alt ajan durduruldu',
      inputSummary: 'Mobile',
      toolKind: null,
    });
  });

  it('labels list_agents and never leaves the raw tool name or kind on a row', () => {
    const p = parser();
    p.push(collab('call_l', 'listAgents', 'tool_call', 'completed'), 2);
    expect(row(p, 'call_l')).toMatchObject({ title: 'Alt ajanlar listelendi', toolKind: null });
  });
});

describe('Codex multi-agent tools (v1: spawnAgent, wait with agent states)', () => {
  it('shows prompt and model at spawn and the final message from the wait result', () => {
    const p = parser();
    p.push(
      collab('call_s', 'spawnAgent', 'tool_call', 'in_progress', {
        prompt: 'Testleri yaz.',
        model: 'gpt-test-sol',
      }),
      2
    );
    p.push(
      collab('call_s', 'spawnAgent', 'tool_call_update', 'completed', {
        receiverThreadIds: [A],
        agentsStates: { [A]: { status: 'pendingInit', message: null } },
        prompt: 'Testleri yaz.',
        model: 'gpt-test-sol',
      }),
      3
    );
    expect(p.agents[0]).toMatchObject({
      agentId: A,
      status: 'running',
      prompt: 'Testleri yaz.',
      model: 'gpt-test-sol',
      provider: 'codex',
    });
    p.push(collab('call_w', 'wait', 'tool_call', 'in_progress', { receiverThreadIds: [A] }), 4);
    p.push(
      collab('call_w', 'wait', 'tool_call_update', 'completed', {
        receiverThreadIds: [A],
        agentsStates: { [A]: { status: 'completed', message: 'Beş test eklendi.' } },
      }),
      5
    );
    expect(p.agents[0]).toMatchObject({ status: 'completed', summary: 'Beş test eklendi.' });
    expect(row(p, 'call_w')).toMatchObject({ title: 'Alt ajanlar bekleniyor (1)' });
    expect(row(p, 'call_s')).toMatchObject({ status: 'done', outputText: 'Beş test eklendi.' });
  });
});
