/**
 * Codex alt ajanlarının gerçek durumu, ajanın kendi oturum kaydından okunur. Kayıtlar ve
 * kimlikler sentetiktir; gerçek bir Codex oturumunun içeriği kullanılmaz.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '#runtimes/acp/api';
import { makeAcpHarness } from '#runtimes/acp/node/acp-test-support';
import { SessionCell } from './cell';
import {
  applyRolloutLine,
  findRolloutFile,
  initialRolloutState,
  parseSpawnCallLine,
  threadIdTimestamp,
} from './codex-subagent-watcher';

const PARENT = '01900000-0000-7000-8000-000000000001';
const CHILD_A = '01900000-1000-7000-8000-00000000000a';
const CHILD_B = '01900000-2000-7000-8000-00000000000b';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Codex'in kayıt düzeni: `sessions/YYYY/MM/DD/rollout-<zaman>-<thread>.jsonl` (yerel gün). */
async function rolloutPath(home: string, threadId: string): Promise<string> {
  const date = new Date(threadIdTimestamp(threadId)!);
  const dir = join(
    home,
    'sessions',
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  );
  await mkdir(dir, { recursive: true });
  return join(dir, `rollout-2024-01-01T00-00-00-${threadId}.jsonl`);
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

const event = (payload: Record<string, unknown>) =>
  line({ timestamp: '2024-01-01T00:00:01.000Z', type: 'event_msg', payload });

const turnContext = (model: string) =>
  line({ type: 'turn_context', payload: { model, effort: 'high' } });

const spawnCall = (callId: string, message: string) =>
  line({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'collaboration',
      call_id: callId,
      arguments: JSON.stringify({ task_name: 'lane', model: 'gpt-test-sol', message }),
    },
  });

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'orkestra-codex-sub-'));
  roots.push(home);
  return home;
}

const MODEL_OPTIONS: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-test-astra',
    options: [
      { value: 'gpt-test-astra', name: 'GPT Test Astra' },
      { value: 'gpt-test-sol', name: 'GPT Test Sol' },
    ],
  } as SessionConfigOption,
];

function makeCellWithAgent(codexHome: string) {
  const h = makeAcpHarness();
  const cell = new SessionCell({
    conversationId: 'conv-codex-sub',
    providerId: 'codex',
    acpSessionId: PARENT,
    agent: h.agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    codexHome,
  });
  cell.applySessionReady({ configOptions: MODEL_OPTIONS });
  return { cell, agent: h.agent };
}

function makeCell(codexHome: string) {
  return makeCellWithAgent(codexHome).cell;
}

/** codex-acp'nin "Start subagent" satırının Codex eklentisindeki karşılığı. */
function spawned(toolCallId: string, agentId: string, title: string): NormalizedEvent {
  return {
    kind: 'subagent',
    operation: 'start',
    toolCallId,
    title,
    status: 'in_progress',
    parentToolCallId: null,
    agentId,
    provider: 'codex',
    detached: true,
  };
}

const launchRow = (cell: SessionCell) =>
  cell.transcript.history.at(-1)?.items.find((item) => item.kind === 'spawn-subagent-tool-call');

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 6000, interval: 100 });

describe('Codex rollout parsing', () => {
  it('follows the last turn of the record: started, completed with answer, interrupted', () => {
    const state = initialRolloutState();
    applyRolloutLine(state, turnContext('gpt-test-sol'));
    applyRolloutLine(state, event({ type: 'task_started', turn_id: 't1' }));
    expect(state).toMatchObject({ status: 'running', model: 'gpt-test-sol', effort: 'high' });
    applyRolloutLine(
      state,
      event({
        type: 'item_completed',
        item: { type: 'CommandExecution', id: 'cmd-1', command: ['/bin/zsh', '-lc', 'ls -la'] },
      })
    );
    applyRolloutLine(state, event({ type: 'task_complete', last_agent_message: 'Bitti.' }));
    expect(state).toMatchObject({ status: 'completed', summary: 'Bitti.' });
    expect(state.activities).toEqual([
      expect.objectContaining({ id: 'cmd-1', kind: 'tool', detail: 'ls -la', status: 'done' }),
    ]);
    // Aynı ajana yeni görev: yeniden çalışır, sonra durdurulur.
    applyRolloutLine(state, event({ type: 'task_started', turn_id: 't2' }));
    expect(state.status).toBe('running');
    expect(state.summary).toBeUndefined();
    applyRolloutLine(state, event({ type: 'turn_aborted', reason: 'interrupted' }));
    expect(state).toMatchObject({ status: 'failed', interrupted: true });
  });

  it('reads the task text of a spawn call from the parent record', () => {
    expect(parseSpawnCallLine(spawnCall('call_x', 'Görevi yap.'))).toEqual({
      callId: 'call_x',
      call: { prompt: 'Görevi yap.', model: 'gpt-test-sol' },
    });
    expect(parseSpawnCallLine(line({ type: 'response_item', payload: {} }))).toBeNull();
  });

  it('does not use an opaque spawn message as a task preview', () => {
    const token = 'gAAAAA' + 'cipher_text-'.repeat(10) + '=';
    expect(parseSpawnCallLine(spawnCall('call_x', token))).toEqual({
      callId: 'call_x',
      call: { model: 'gpt-test-sol' },
    });
  });

  it('finds a record by the creation day encoded in a UUIDv7 thread id', async () => {
    const home = await makeHome();
    const file = await rolloutPath(home, CHILD_A);
    await writeFile(file, '');
    await expect(findRolloutFile(home, CHILD_A)).resolves.toBe(file);
    await expect(findRolloutFile(home, CHILD_B)).resolves.toBeNull();
    await expect(findRolloutFile(home, '../escape')).resolves.toBeNull();
  });
});

describe('SessionCell Codex sub-agents', () => {
  it('shows a spawned agent running past the turn end and completes it from its own record', async () => {
    const home = await makeHome();
    await writeFile(await rolloutPath(home, PARENT), spawnCall('call_a', 'Mobil kutuyu düzelt.'));
    const child = await rolloutPath(home, CHILD_A);
    await writeFile(child, turnContext('gpt-test-sol') + event({ type: 'task_started' }));
    const { cell, agent } = makeCellWithAgent(home);

    // Ana ajan alt ajanı başlatır ve turunu bitirir; alt ajan çalışmayı sürdürür.
    agent.prompt.mockImplementation(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: 'a1', text: 'Başlatıyorum.' });
      cell.push(spawned('call_a', CHILD_A, 'Mobile'));
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'alt ajan başlat' });
    expect(cell.transcript.agents[0]).toMatchObject({
      agentId: CHILD_A,
      toolCallId: 'call_a',
      status: 'running',
      provider: 'codex',
      detached: true,
    });
    // Oturum meşgul sayılmaz: kullanıcı ana ajanla konuşmayı sürdürebilir.
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.backgroundAgentCount).toBe(0);
    expect(launchRow(cell)).toMatchObject({ kind: 'spawn-subagent-tool-call', status: 'running' });

    await waitFor(() =>
      expect(cell.transcript.agents[0]).toMatchObject({
        model: 'GPT Test Sol',
        prompt: 'Mobil kutuyu düzelt.',
      })
    );

    await appendFile(
      child,
      event({
        type: 'item_completed',
        item: { type: 'CommandExecution', id: 'cmd-1', command: 'pnpm test', exit_code: 0 },
      }) + event({ type: 'task_complete', last_agent_message: 'Kutu düzeldi, testler geçti.' })
    );
    await waitFor(() => expect(cell.transcript.agents[0]?.status).toBe('completed'));
    expect(cell.transcript.agents[0]).toMatchObject({
      summary: 'Kutu düzeldi, testler geçti.',
      activities: [expect.objectContaining({ id: 'cmd-1', detail: 'pnpm test' })],
    });
    expect(launchRow(cell)).toMatchObject({
      kind: 'spawn-subagent-tool-call',
      status: 'done',
      outputText: 'Kutu düzeldi, testler geçti.',
    });
    cell.dispose();
  });

  it('marks an agent interrupted when its record says the turn was interrupted', async () => {
    const home = await makeHome();
    const child = await rolloutPath(home, CHILD_A);
    await writeFile(child, event({ type: 'task_started' }));
    const cell = makeCell(home);
    cell.push(spawned('call_a', CHILD_A, 'Mobile'));
    await appendFile(child, event({ type: 'turn_aborted', reason: 'interrupted' }));
    await waitFor(() =>
      expect(cell.transcript.agents[0]).toMatchObject({ status: 'failed', interrupted: true })
    );
    cell.dispose();
  });

  it('tracks two agents in parallel independently', async () => {
    const home = await makeHome();
    const childA = await rolloutPath(home, CHILD_A);
    const childB = await rolloutPath(home, CHILD_B);
    await writeFile(childA, event({ type: 'task_started' }));
    await writeFile(childB, event({ type: 'task_started' }));
    const cell = makeCell(home);
    cell.push(spawned('call_a', CHILD_A, 'Mobile'));
    cell.push(spawned('call_b', CHILD_B, 'Sidebar'));
    await appendFile(childB, event({ type: 'task_complete', last_agent_message: 'B bitti.' }));
    await waitFor(() =>
      expect(cell.transcript.agents.find((a) => a.agentId === CHILD_B)?.status).toBe('completed')
    );
    expect(cell.transcript.agents.find((a) => a.agentId === CHILD_A)?.status).toBe('running');
    cell.dispose();
  });

  it('restores true final states after a reload and never leaves an unknowable agent running', async () => {
    const home = await makeHome();
    await writeFile(
      await rolloutPath(home, CHILD_A),
      event({ type: 'task_started' }) +
        event({ type: 'task_complete', last_agent_message: 'Tamam.' })
    );
    // B'nin kaydı bir tur başlatmış ama bitişi yok: önceki süreç kapandı.
    await writeFile(await rolloutPath(home, CHILD_B), event({ type: 'task_started' }));
    const cell = makeCell(home);

    cell.beginReplay();
    cell.push({ kind: 'message', role: 'user', messageId: 'u1', text: 'iki ajan başlat' });
    cell.push(spawned('call_a', CHILD_A, 'Mobile'));
    cell.push(spawned('call_b', CHILD_B, 'Sidebar'));
    cell.endReplay();

    await waitFor(() => {
      expect(cell.transcript.agents.find((a) => a.agentId === CHILD_A)).toMatchObject({
        status: 'completed',
        summary: 'Tamam.',
      });
      expect(cell.transcript.agents.find((a) => a.agentId === CHILD_B)).toMatchObject({
        status: 'completed',
        statusUnknown: true,
      });
    });
    cell.dispose();
  });
});
