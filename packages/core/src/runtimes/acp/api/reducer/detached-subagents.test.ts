/**
 * Turdan bağımsız çalışan (kopuk) alt ajanlar ve alt ajan durumu taşıyan araç satırları (Codex
 * `wait`, `interrupt_agent`). Kimlikler sentetiktir.
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from './normalized-event';
import { AcpTranscriptParser } from './parser';

const AGENT_A = 'thread-a';
const AGENT_B = 'thread-b';

function parser() {
  const p = new AcpTranscriptParser({ conversationId: 'conv-detached' });
  p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'iki ajan başlat' }, 1);
  return p;
}

function spawn(p: AcpTranscriptParser, toolCallId: string, agentId: string, title: string) {
  p.pushEvent(
    {
      kind: 'subagent',
      operation: 'start',
      toolCallId,
      title,
      status: 'in_progress',
      parentToolCallId: null,
      agentId,
      provider: 'codex',
      detached: true,
    },
    2
  );
}

function row(
  toolCallId: string,
  title: string,
  extra: Partial<Extract<NormalizedEvent, { kind: 'tool_call' }>> = {}
): NormalizedEvent {
  return {
    kind: 'tool_call',
    toolCallId,
    title,
    toolKind: null,
    status: 'completed',
    parentToolCallId: null,
    diffs: [],
    locations: [],
    ...extra,
  };
}

function launchRow(p: AcpTranscriptParser, toolCallId: string): unknown {
  const turns = [...p.history, ...(p.activeTurn ? [p.activeTurn] : [])];
  // Ardışık araç satırları bir gruba toplanabilir; grubun içine de bak.
  const flatten = (items: readonly unknown[]): unknown[] =>
    items.flatMap((item) => {
      const children = (item as { children?: unknown[] }).children;
      return [item, ...(children ? flatten(children) : [])];
    });
  return flatten(turns.flatMap((turn) => turn.items)).find(
    (item) => (item as { toolCallId?: string }).toolCallId === toolCallId
  );
}

describe('detached sub-agents', () => {
  it('keeps a detached agent and its launch row running when the turn closes', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    p.settleTurn({ kind: 'done', reason: 'end_turn' }, 3);
    expect(p.agents[0]).toMatchObject({ agentId: AGENT_A, status: 'running', detached: true });
    expect(p.agents[0]?.background).toBeUndefined();
    expect(launchRow(p, 'call_a')).toMatchObject({
      kind: 'spawn-subagent-tool-call',
      status: 'running',
    });
    expect(launchRow(p, 'call_a')).not.toHaveProperty('statusUnknown');
  });

  it('applies a reported final answer to the card and the launch row', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    p.settleTurn({ kind: 'done', reason: 'end_turn' }, 3);
    p.pushEvent(
      {
        kind: 'subagent_update',
        toolCallId: 'call_a',
        agentId: AGENT_A,
        status: 'completed',
        summary: 'Tamamlandı: 3 dosya.',
        prompt: 'Mobil giden kutusunu düzelt.',
      },
      4
    );
    expect(p.agents[0]).toMatchObject({
      status: 'completed',
      summary: 'Tamamlandı: 3 dosya.',
      prompt: 'Mobil giden kutusunu düzelt.',
      completedAt: 4,
    });
    expect(launchRow(p, 'call_a')).toMatchObject({
      status: 'done',
      outputText: 'Tamamlandı: 3 dosya.',
      inputSummary: 'Mobil giden kutusunu düzelt.',
    });
  });

  it('marks an agent interrupted from a row that reports it, only while it runs', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    spawn(p, 'call_b', AGENT_B, 'Sidebar');
    p.pushEvent(
      { kind: 'subagent_update', agentId: AGENT_B, status: 'completed', summary: 'B bitti.' },
      3
    );
    p.pushEvent(
      row('call_stop', 'Alt ajan durduruldu', {
        subagentUpdates: [
          { agentId: AGENT_A, status: 'failed', interrupted: true, ifRunning: true },
          { agentId: AGENT_B, status: 'failed', interrupted: true, ifRunning: true },
        ],
      }),
      4
    );
    expect(p.agents.find((a) => a.agentId === AGENT_A)).toMatchObject({
      status: 'failed',
      interrupted: true,
    });
    // Bitmiş ajanın bilinen sonucu ezilmez.
    expect(p.agents.find((a) => a.agentId === AGENT_B)).toMatchObject({
      status: 'completed',
      summary: 'B bitti.',
    });
    expect(p.agents.find((a) => a.agentId === AGENT_B)).not.toHaveProperty('interrupted');
    expect(launchRow(p, 'call_a')).toMatchObject({ status: 'error' });
    expect(launchRow(p, 'call_stop')).toMatchObject({ title: 'Alt ajan durduruldu' });
  });

  it('applies a wait result with the final message of each agent', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    spawn(p, 'call_b', AGENT_B, 'Sidebar');
    p.pushEvent(
      row('call_wait', 'Alt ajanlar bekleniyor', {
        subagentUpdates: [{ agentId: AGENT_A, status: 'completed', summary: 'A bitti.' }],
      }),
      3
    );
    expect(p.agents.find((a) => a.agentId === AGENT_A)).toMatchObject({
      status: 'completed',
      summary: 'A bitti.',
    });
    expect(p.agents.find((a) => a.agentId === AGENT_B)?.status).toBe('running');
  });

  it('names the awaited agents on a wait row', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    spawn(p, 'call_b', AGENT_B, 'Sidebar');
    p.pushEvent(row('call_wait_all', 'Alt ajanlar bekleniyor', { awaitsSubagents: [] }), 3);
    expect(launchRow(p, 'call_wait_all')).toMatchObject({
      title: 'Alt ajanlar bekleniyor (2)',
      inputSummary: 'Mobile, Sidebar',
    });
    p.pushEvent(row('call_wait_one', 'Alt ajanlar bekleniyor', { awaitsSubagents: [AGENT_B] }), 4);
    expect(launchRow(p, 'call_wait_one')).toMatchObject({
      title: 'Alt ajanlar bekleniyor (1)',
      inputSummary: 'Sidebar',
    });
  });

  it('returns a finished agent to running when its record shows a new turn', () => {
    const p = parser();
    spawn(p, 'call_a', AGENT_A, 'Mobile');
    p.pushEvent(
      { kind: 'subagent_update', agentId: AGENT_A, status: 'failed', interrupted: true },
      3
    );
    p.pushEvent({ kind: 'subagent_update', agentId: AGENT_A, status: 'in_progress' }, 4);
    expect(p.agents[0]?.status).toBe('running');
    expect(p.agents[0]).not.toHaveProperty('interrupted');
    expect(p.agents[0]).not.toHaveProperty('completedAt');
  });
});
