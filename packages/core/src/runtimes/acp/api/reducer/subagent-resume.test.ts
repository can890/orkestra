/**
 * Arka plan alt ajanının bitiş ve yeniden başlatma (Claude `SendMessage`) bildirimleri, ajanın
 * dökümdeki başlatma satırını ve ajan listesini doğru kapatmalı. Kimlikler sentetiktir.
 */
import { describe, expect, it } from 'vitest';
import type { ToolNode, TranscriptItem } from '../models/turns';
import type { NormalizedEvent } from './normalized-event';
import { AcpTranscriptParser } from './parser';

const LAUNCH = 'toolu_launch_a';
const OTHER = 'toolu_launch_b';
const AGENT = 'a0000000000000001';
const OTHER_AGENT = 'a0000000000000002';

function parser() {
  return new AcpTranscriptParser({ conversationId: 'conv-resume' });
}

function launch(p: AcpTranscriptParser, toolCallId: string, agentId: string, at: number) {
  p.pushEvent(
    {
      kind: 'subagent',
      operation: 'start',
      toolCallId,
      title: 'Agent',
      status: 'pending',
      parentToolCallId: null,
      provider: 'claude',
    },
    at
  );
  p.pushEvent(
    {
      kind: 'subagent',
      operation: 'update',
      toolCallId,
      title: 'Agent',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
      agentId,
      provider: 'claude',
    },
    at
  );
}

function userTurn(p: AcpTranscriptParser, id: string, at: number) {
  p.pushEvent({ kind: 'message', role: 'user', messageId: id, text: `istek ${id}` }, at);
}

function sendMessage(
  p: AcpTranscriptParser,
  toolCallId: string,
  at: number,
  resumesAgentId?: string
) {
  p.pushEvent(
    {
      kind: 'tool_call',
      toolCallId,
      title: 'SendMessage',
      toolKind: 'other',
      status: 'pending',
      parentToolCallId: null,
      diffs: [],
      locations: [],
    },
    at
  );
  const update: NormalizedEvent = {
    kind: 'tool_update',
    toolCallId,
    status: 'completed',
    parentToolCallId: null,
    ...(resumesAgentId ? { resumesAgentId } : {}),
  };
  p.pushEvent(update, at);
}

function completion(
  p: AcpTranscriptParser,
  toolCallId: string,
  agentId: string,
  at: number,
  summary = 'rapor'
) {
  p.pushEvent({ kind: 'subagent_update', toolCallId, agentId, status: 'completed', summary }, at);
}

function toolNodes(p: AcpTranscriptParser): ToolNode[] {
  const out: ToolNode[] = [];
  const visit = (items: readonly (TranscriptItem | ToolNode)[]) => {
    for (const item of items) {
      if (item.kind === 'message' || item.kind === 'thinking') continue;
      out.push(item);
      if ('children' in item && item.children) visit(item.children);
    }
  };
  for (const turn of p.history) visit(turn.items);
  if (p.activeTurn) visit(p.activeTurn.items);
  return out;
}

function node(p: AcpTranscriptParser, toolCallId: string) {
  const found = toolNodes(p).find((item) => 'toolCallId' in item && item.toolCallId === toolCallId);
  if (!found) throw new Error(`node ${toolCallId} not found`);
  return found as ToolNode & { status: string; statusUnknown?: boolean };
}

function runningSpawnRows(p: AcpTranscriptParser): string[] {
  return toolNodes(p)
    .filter(
      (item) =>
        item.kind === 'spawn-subagent-tool-call' && item.status === 'running' && !item.statusUnknown
    )
    .map((item) => (item as { toolCallId: string }).toolCallId);
}

describe('background sub-agent completion and resume', () => {
  it('closes the launch row when the only completion carries a resuming SendMessage id', () => {
    // Gerçek oturumda görülen durum: ilk bitiş turun ortasında tüketildi (akışa düşmedi), ajan
    // sonra SendMessage ile yeniden başlatıldı ve son bitiş bildirimi o çağrının kimliğini taşıdı.
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    p.endTurn(120);
    userTurn(p, 'u2', 200);
    sendMessage(p, 'toolu_send_resume', 210, AGENT);
    p.endTurn(220);
    completion(p, 'toolu_send_resume', AGENT, 300, 'ikinci rapor');

    expect(node(p, LAUNCH).status).toBe('done');
    expect(runningSpawnRows(p)).toEqual([]);
    expect(p.agents).toHaveLength(1);
    expect(p.agents[0]).toMatchObject({
      agentId: AGENT,
      // Kart başlatma çağrısına bağlı kalır; SendMessage kimliği kartı taşımaz.
      toolCallId: LAUNCH,
      status: 'completed',
      summary: 'ikinci rapor',
    });
    // SendMessage satırı kendi sonucuyla kapanmıştı; bildirim ona dokunmaz.
    expect(node(p, 'toolu_send_resume').status).toBe('done');
  });

  it('shows a resumed agent as running until its new completion arrives', () => {
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    p.endTurn(120);
    completion(p, LAUNCH, AGENT, 150, 'ilk rapor');
    expect(p.agents[0]?.status).toBe('completed');
    expect(node(p, LAUNCH).status).toBe('done');

    userTurn(p, 'u2', 200);
    sendMessage(p, 'toolu_send_resume', 210, AGENT);
    expect(p.agents[0]).toMatchObject({ status: 'running', toolCallId: LAUNCH });
    expect(p.agents[0]?.completedAt).toBeUndefined();
    expect(node(p, LAUNCH).status).toBe('running');
    p.endTurn(220);
    // Tur bitse de yeniden başlatılan arka plan ajanı çalışmaya devam eder.
    expect(runningSpawnRows(p)).toEqual([LAUNCH]);

    completion(p, 'toolu_send_resume', AGENT, 300, 'ikinci rapor');
    expect(p.agents[0]).toMatchObject({ status: 'completed', summary: 'ikinci rapor' });
    expect(runningSpawnRows(p)).toEqual([]);
  });

  it('a message queued to a still-running agent neither resumes nor completes it', () => {
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    launch(p, OTHER, OTHER_AGENT, 111);
    sendMessage(p, 'toolu_send_queued', 115);
    p.endTurn(120);
    expect(runningSpawnRows(p)).toEqual([LAUNCH, OTHER]);

    completion(p, LAUNCH, AGENT, 200);
    expect(runningSpawnRows(p)).toEqual([OTHER]);
    completion(p, OTHER, OTHER_AGENT, 210);
    expect(runningSpawnRows(p)).toEqual([]);
    expect(p.agents.map((agent) => [agent.toolCallId, agent.status])).toEqual([
      [LAUNCH, 'completed'],
      [OTHER, 'completed'],
    ]);
  });

  it('a SendMessage naming an agent that is still running does not restart it', () => {
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    sendMessage(p, 'toolu_send', 115, AGENT);
    expect(p.agents[0]).toMatchObject({ status: 'running', startedAt: 110 });
    completion(p, LAUNCH, AGENT, 200);
    expect(runningSpawnRows(p)).toEqual([]);
  });

  it('marks an agent with unknown outcome as ended without claiming completion', () => {
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    launch(p, OTHER, OTHER_AGENT, 111);
    p.endTurn(120);
    completion(p, OTHER, OTHER_AGENT, 150);

    for (const [toolCallId, agentId] of [
      [LAUNCH, AGENT],
      [OTHER, OTHER_AGENT],
    ] as const) {
      p.pushEvent(
        { kind: 'subagent_update', toolCallId, agentId, status: 'completed', statusUnknown: true },
        300
      );
    }

    expect(runningSpawnRows(p)).toEqual([]);
    expect(node(p, LAUNCH)).toMatchObject({ status: 'done', statusUnknown: true });
    expect(p.agents[0]).toMatchObject({ status: 'completed', statusUnknown: true });
    // Bilinen sonuç ezilmez.
    expect(node(p, OTHER).statusUnknown).toBeUndefined();
    expect(p.agents[1]?.statusUnknown).toBeUndefined();
    expect(p.agents[1]?.completedAt).toBe(150);
  });

  it('a later real completion replaces an unknown outcome', () => {
    const p = parser();
    userTurn(p, 'u1', 100);
    launch(p, LAUNCH, AGENT, 110);
    p.endTurn(120);
    p.pushEvent(
      {
        kind: 'subagent_update',
        toolCallId: LAUNCH,
        agentId: AGENT,
        status: 'completed',
        statusUnknown: true,
      },
      200
    );
    completion(p, LAUNCH, AGENT, 300);
    expect(node(p, LAUNCH).statusUnknown).toBeUndefined();
    expect(p.agents[0]?.statusUnknown).toBeUndefined();
  });
});
