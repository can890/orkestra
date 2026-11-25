/**
 * Antigravity adaptörünün agy acp taşımasında ürettiği alt ajan satırları sağ paneldeki kartlara
 * gerçek durumlarıyla düşer. Güncellemelerin biçimi adaptörün gerçek agy 1.5.17 çalıştırmalarındaki
 * çıktısıdır (yakalama r06/r07/r09); kimlikler sentetiktir.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { enrichAntigravityUpdate } from './acp-transform';

const SUB = 'aaaaaaaa-1111-4111-8111-111111111111';

function card(
  sessionUpdate: 'tool_call' | 'tool_call_update',
  status: string,
  meta: Record<string, unknown>
): SessionUpdate {
  return {
    sessionUpdate,
    toolCallId: 'agy-acp-1',
    title: 'Beta',
    kind: 'other',
    status: meta.statusUnknown ? 'completed' : status,
    _meta: {
      antigravity: {
        kind: sessionUpdate === 'tool_call' ? 'subagent' : 'subagent_update',
        toolCallId: 'agy-acp-1',
        title: 'Beta',
        provider: 'antigravity',
        role: 'self',
        prompt: 'Run `sleep 8 && echo beta`.',
        background: true,
        detached: true,
        status: meta.statusUnknown ? 'completed' : status,
        ...meta,
      },
    },
  } as unknown as SessionUpdate;
}

function started(): AcpTranscriptParser {
  const parser = new AcpTranscriptParser({
    conversationId: 'conv-agy',
    enrich: enrichAntigravityUpdate,
  });
  parser.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'alt ajan başlat' }, 1);
  parser.push(card('tool_call', 'in_progress', {}), 2);
  parser.push(
    card('tool_call_update', 'in_progress', {
      agentId: SUB,
      outputFile: `/brain/${SUB}/.system_generated/logs/transcript.jsonl`,
      model: 'Gemini 3.8 Flash',
      effort: 'low',
      activities: [{ id: 'tool-1-0', kind: 'tool', title: 'Komut çalıştırılıyor', status: 'done' }],
    }),
    3
  );
  return parser;
}

describe('antigravity sub-agent cards on the agy acp transport', () => {
  it('a built-in sub-agent card is detached (no Stop) and keeps running past the turn end', () => {
    const parser = started();
    parser.endTurn(4);
    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({
      agentId: SUB,
      toolCallId: 'agy-acp-1',
      name: 'Beta',
      status: 'running',
      detached: true,
      provider: 'antigravity',
      model: 'Gemini 3.8 Flash',
      effort: 'low',
      prompt: 'Run `sleep 8 && echo beta`.',
    });
    const row = parser.history.at(-1)?.items.find((item) => item.kind !== 'message');
    expect(row).toMatchObject({ kind: 'spawn-subagent-tool-call', status: 'running' });
  });

  it('a stopped sub-agent is "stopped", not an error', () => {
    const parser = started();
    parser.push(
      card('tool_call_update', 'failed', { interrupted: true, summary: 'Alt ajan durduruldu.' }),
      5
    );
    expect(parser.agents[0]).toMatchObject({
      status: 'failed',
      interrupted: true,
      summary: 'Alt ajan durduruldu.',
      completedAt: 5,
    });
  });

  it('a sub-agent whose end nobody saw ends "outcome unknown"', () => {
    const parser = started();
    parser.push(card('tool_call_update', 'completed', { statusUnknown: true }), 6);
    expect(parser.agents[0]).toMatchObject({ status: 'completed', statusUnknown: true });
  });

  it('a finished sub-agent keeps its answer', () => {
    const parser = started();
    parser.push(card('tool_call_update', 'completed', { summary: 'beta' }), 7);
    expect(parser.agents[0]).toMatchObject({ status: 'completed', summary: 'beta' });
    expect(parser.agents[0].statusUnknown).toBeUndefined();
    expect(parser.agents[0].interrupted).toBeUndefined();
  });

  it('stream-json sub-agent metadata (no detached flag) is read exactly as before', () => {
    const parser = new AcpTranscriptParser({
      conversationId: 'conv-agy-sj',
      enrich: enrichAntigravityUpdate,
    });
    parser.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'go' }, 1);
    const update = card('tool_call', 'in_progress', { agentId: SUB });
    const meta = (update as unknown as { _meta: { antigravity: Record<string, unknown> } })._meta;
    delete meta.antigravity.detached;
    parser.push(update, 2);
    expect(parser.agents[0].detached).toBeUndefined();
    expect(parser.agents[0]).toMatchObject({ status: 'running', background: true });
  });
});
