/**
 * Geçmiş yeniden oynatılırken alt ajan satırlarının gerçek ACP kablosu üzerinden
 * (ajan stdout'u → koruma → SDK `ClientSideConnection` → çalışma zamanı) geri
 * geldiğini doğrular. Sahte ajan bildirimleri ham NDJSON olarak yazar; böylece
 * SDK'nın katı şemasının reddedeceği eski biçim de sınanır.
 */

import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
} from '@agentclientprotocol/sdk';
import type { Logger } from '@orkestra/shared/logger';
import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolNode, TranscriptItem } from '#runtimes/acp/api';
import {
  makeAcpHarness,
  makeStartInput,
  type FakeAcpProcessHandle,
} from '#runtimes/acp/node/acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION_ID = 'agy-native-session';

/** Antigravity'nin yeniden oynatma satırları: kullanıcı iletisi, alt ajanlar ve komşu araç. */
function replayUpdates(): Record<string, unknown>[] {
  return [
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'ekibi kur' },
    },
    // 0.1.15/0.1.16 yazarının biçimi: ACP dışı `kind` (SDK bunu bütünüyle reddeder).
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-0',
      title: 'hub · Gemini 4 Argon (Yüksek)',
      kind: 'subagent',
      status: 'completed',
      rawInput: { action: 'add', name: 'hub', description: 'hub görevi' },
    },
    // Komşu sıradan araç satırı.
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-1',
      title: 'Swarm: durum',
      kind: 'other',
      status: 'completed',
      rawInput: { action: 'status' },
    },
    // Düzeltilmiş yazarın biçimi: sözleşmeye uygun `kind`, asıl tür `_meta` içinde.
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-2',
      title: 'extension · Gemini 4 Argon (Yüksek)',
      kind: 'other',
      status: 'in_progress',
      rawInput: { action: 'add', name: 'extension', description: 'extension görevi' },
      _meta: { orkestra: { toolKind: 'subagent' } },
    },
    // Aynı ACP dışı türden ikinci satır: yine kabul edilir, uyarı ikinci kez yazılmaz.
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-3',
      title: 'scout',
      kind: 'subagent',
      status: 'in_progress',
    },
    // Onarılamayan satır (zorunlu `title` yok): yalnızca kendisi düşer.
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-4',
      kind: 'other',
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ekip hazır' },
    },
  ];
}

function startFakeAgent(handle: FakeAcpProcessHandle): void {
  const writeRaw = (message: unknown) => handle.stdout.write(JSON.stringify(message) + '\n');
  const agent: Agent = {
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    newSession: async () => ({ sessionId: SESSION_ID }),
    loadSession: async ({ sessionId }) => {
      for (const update of replayUpdates()) {
        writeRaw({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
      }
      return {};
    },
    authenticate: async () => ({}),
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
  };
  new AgentSideConnection(
    () => agent,
    ndJsonStream(
      Writable.toWeb(handle.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(handle.stdin) as unknown as ReadableStream<Uint8Array>
    )
  );
}

function recordingLogger() {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

function createHarness() {
  const { logger, warn } = recordingLogger();
  const h = makeAcpHarness({
    logger,
    acpBehavior: {
      buildSpawn: () => ({ command: '/fake/agy', args: ['acp'], env: {} }),
      connect: (io, toClient) =>
        new ClientSideConnection(
          (agent) => toClient(agent as never),
          ndJsonStream(
            Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(io.stdout) as unknown as ReadableStream<Uint8Array>
          )
        ),
    },
  });
  const spawn = h.fakeHost.spawn.bind(h.fakeHost);
  h.fakeHost.spawn = async (spec) => {
    const handle = await spawn(spec);
    startFakeAgent(handle as FakeAcpProcessHandle);
    return handle;
  };
  return { h, runtime: new AcpRuntime(h.deps), warn };
}

/** Araç satırları (gruplar ve alt düğümler dahil) `[toolCallId, kind, status]` olarak. */
function toolRows(items: readonly (TranscriptItem | ToolNode)[]): Array<[string, string, string]> {
  return items.flatMap((item): Array<[string, string, string]> => {
    if (item.kind === 'message' || item.kind === 'thinking') return [];
    if (item.kind === 'tool-group') return toolRows(item.children);
    if (!('toolCallId' in item)) return [];
    const children = 'children' in item && item.children ? toolRows(item.children) : [];
    return [[item.toolCallId, item.kind, item.status], ...children];
  });
}

let runtime: AcpRuntime | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

describe('sub-agent rows in replayed history', () => {
  it('come back as sub-agent rows (finished and running) next to their neighbours', async () => {
    const harness = createHarness();
    runtime = harness.runtime;
    const conversationId = 'subagent-history-replay';
    const launched = await runtime.launchSession(
      makeStartInput({ conversationId, providerId: 'claude', sessionId: SESSION_ID })
    );
    expect(launched.success).toBe(true);

    const history = await runtime.loadHistory(conversationId);
    if (!history.success) throw new Error(`history failed: ${history.error.type}`);
    const items = history.data.turns.flatMap((turn) => turn.items);
    const rows = toolRows(items);

    // Yeniden oynatılan tur tamamlanmış tur olarak işlenir; ön plandaki `in_progress` satırlar
    // `finalizeItems` kuralıyla kapanır. Burada önemli olan satırların alt ajan olarak dönmesi.
    expect(rows).toEqual([
      ['agy-replay-1-0', 'spawn-subagent-tool-call', 'done'],
      ['agy-replay-1-1', expect.not.stringMatching(/subagent/), 'done'],
      ['agy-replay-1-2', 'spawn-subagent-tool-call', 'done'],
      ['agy-replay-1-3', 'spawn-subagent-tool-call', 'done'],
    ]);
    // Mesajlar da (geçersiz satırın ardından gelen dahil) kaybolmaz.
    const texts = items.flatMap((item) => (item.kind === 'message' ? [item.text] : []));
    expect(texts).toEqual(['ekibi kur', 'ekip hazır']);

    // ACP dışı tür bir kez, satırı tanıtan bağlamla günlüğe yazılır.
    const repaired = harness.warn.mock.calls.filter(([message]) =>
      String(message).startsWith('ACP session update repaired')
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.[1]).toMatchObject({
      sessionId: SESSION_ID,
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-0',
      field: 'kind',
      value: 'subagent',
    });
  });
});
