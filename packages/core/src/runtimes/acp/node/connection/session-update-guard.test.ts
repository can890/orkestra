import { PassThrough } from 'node:stream';
import type { Logger } from '@orkestra/shared/logger';
import { noopLogger } from '@orkestra/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { guardAcpStdout, repairSessionUpdateMessage } from './session-update-guard';

const notification = (update: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'c690e587', update },
});

// Sunucu günlüğündeki reddedilen satırın biçimi (içerik kısaltıldı).
const replayedSwarmMember = () =>
  notification({
    sessionUpdate: 'tool_call',
    toolCallId: 'agy-replay-674-0',
    title: 'hub · Gemini 4 Argon (Yüksek)',
    kind: 'subagent',
    rawInput: { action: 'add', name: 'hub' },
    status: 'in_progress',
    rawOutput: '{"status":"added","name":"hub"}',
  });

function recordingLogger() {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

async function pipeLines(chunks: Array<string | Buffer>, logger: Logger): Promise<string> {
  const source = new PassThrough();
  const guarded = guardAcpStdout(source, logger);
  const out: Buffer[] = [];
  guarded.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
  const done = new Promise((resolve) => guarded.on('end', resolve));
  for (const chunk of chunks) source.write(chunk);
  source.end();
  await done;
  return Buffer.concat(out).toString('utf8');
}

describe('repairSessionUpdateMessage()', () => {
  it('moves a kind outside the ACP contract into _meta.orkestra.toolKind', () => {
    const message = replayedSwarmMember();
    expect(repairSessionUpdateMessage(message)).toEqual([
      { field: 'kind', value: 'subagent', action: 'moved-to-meta' },
    ]);
    expect(message.params.update).toMatchObject({
      kind: 'other',
      status: 'in_progress',
      _meta: { orkestra: { toolKind: 'subagent' } },
    });
  });

  it('keeps existing _meta fields and an explicit Orkestra kind', () => {
    const message = notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      kind: 'agent',
      _meta: { antigravity: { kind: 'subagent' }, orkestra: { toolKind: 'subagent' } },
    });
    repairSessionUpdateMessage(message);
    expect(message.params.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      kind: 'other',
      _meta: { antigravity: { kind: 'subagent' }, orkestra: { toolKind: 'subagent' } },
    });
  });

  it('drops an invalid tool_call status and non-object _meta', () => {
    const message = notification({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'x',
      status: 'running',
      _meta: 'oops',
    });
    expect(repairSessionUpdateMessage(message).map((r) => [r.field, r.action])).toEqual([
      ['_meta', 'dropped'],
      ['status', 'dropped'],
    ]);
    expect(message.params.update).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'x',
    });
  });

  it('reports a missing required field without inventing one', () => {
    const message = notification({ sessionUpdate: 'tool_call', toolCallId: 't', kind: 'read' });
    expect(repairSessionUpdateMessage(message)).toEqual([
      { field: 'title', value: 'undefined', action: 'rejected' },
    ]);
    expect(message.params.update).not.toHaveProperty('title');
  });

  it('leaves valid and unrelated messages alone', () => {
    for (const message of [
      notification({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind: 'execute' }),
      notification({ sessionUpdate: 'tool_call_update', toolCallId: 't', kind: null }),
      notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'k' } }),
      { jsonrpc: '2.0', id: 1, result: { kind: 'subagent' } },
    ]) {
      const before = structuredClone(message);
      expect(repairSessionUpdateMessage(message)).toEqual([]);
      expect(message).toEqual(before);
    }
  });
});

describe('guardAcpStdout()', () => {
  it('repairs the rejected row, keeps its neighbours byte-identical and logs once', async () => {
    const { logger, warn } = recordingLogger();
    const neighbour = JSON.stringify(
      notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ğü' } })
    );
    const response = JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} });
    const input = [
      neighbour,
      JSON.stringify(replayedSwarmMember()),
      JSON.stringify(replayedSwarmMember()),
      response,
      'not json',
    ].join('\n');
    // Çok baytlı karakterin ortasından bölünen parçalar da doğru birleşir.
    const bytes = Buffer.from(input + '\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('ğ', 'utf8')) + 1;
    const output = await pipeLines([bytes.subarray(0, cut), bytes.subarray(cut)], logger);

    const lines = output.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(neighbour);
    expect(JSON.parse(lines[1]!).params.update).toMatchObject({
      toolCallId: 'agy-replay-674-0',
      kind: 'other',
      _meta: { orkestra: { toolKind: 'subagent' } },
    });
    expect(lines[2]).toBe(lines[1]);
    expect(lines[3]).toBe(response);
    expect(lines[4]).toBe('not json');
    expect(lines[5]).toBe('');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toEqual({
      sessionId: 'c690e587',
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-674-0',
      field: 'kind',
      value: 'subagent',
      action: 'moved-to-meta',
    });
  });

  it('passes a final line without a trailing newline through', async () => {
    const line = JSON.stringify(replayedSwarmMember());
    const output = await pipeLines([line], recordingLogger().logger);
    expect(JSON.parse(output).params.update.kind).toBe('other');
  });
});
