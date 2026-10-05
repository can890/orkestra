import type { ToolNode, TranscriptTurn } from '@orkestra/chat-ui';
import { describe, expect, it } from 'vitest';
import type { OrchestraWorkerSummary } from '@core/features/orchestra/api/orchestra';
import {
  collectNativeSubagents,
  collectOrchestraSpawns,
  findToolNode,
  matchOrchestraWorkers,
  phaseFromAgentStatus,
  toolFeedEntries,
  transcriptFeed,
  transcriptTurns,
} from './subagent-activity';

const spawn = (
  id: string,
  status: 'running' | 'done' | 'error',
  inputSummary?: string
): ToolNode => ({
  kind: 'unknown-tool-call',
  id: `item-${id}`,
  seq: 0,
  toolCallId: id,
  title: 'mcp__orkestra__spawn_agent',
  status,
  toolKind: 'other',
  name: 'mcp__orkestra__spawn_agent',
  ...(inputSummary ? { inputSummary } : {}),
});

const nativeSubagent: ToolNode = {
  kind: 'spawn-subagent-tool-call',
  id: 'item-agent',
  seq: 1,
  toolCallId: 'agent-1',
  title: 'Kod tabanını tara',
  status: 'running',
  name: 'Kod tabanını tara',
  agentId: 'a1',
  children: [
    {
      kind: 'read-tool-call',
      id: 'item-read',
      seq: 0,
      toolCallId: 'read-1',
      title: 'Read',
      status: 'done',
      locations: [{ path: 'src/index.ts' }],
    },
    {
      kind: 'execute-tool-call',
      id: 'item-exec',
      seq: 1,
      toolCallId: 'exec-1',
      title: 'Terminal',
      status: 'running',
      command: 'pnpm test',
    },
  ],
};

const turn = (items: TranscriptTurn['items']): TranscriptTurn => ({
  id: 'turn',
  seq: 0,
  initiator: 'user',
  items,
});

const worker = (workerId: string, createdAt: number, description?: string) =>
  ({
    workerId,
    providerId: 'codex',
    agentName: 'Codex',
    model: 'gpt-6.1-sol',
    title: workerId,
    role: null,
    createdAt,
    ...(description ? { description } : {}),
  }) satisfies OrchestraWorkerSummary;

describe('subagent activity', () => {
  it('finds native sub-agents and their child steps in the live turn', () => {
    const turns = transcriptTurns({
      displayTurns: [turn([spawn('s1', 'done', 'Codex — testler')])],
      activeTurnSnapshot: turn([nativeSubagent]),
    });
    expect(collectNativeSubagents(turns)).toEqual([
      { itemId: 'item-agent', toolCallId: 'agent-1', name: 'Kod tabanını tara', phase: 'running' },
    ]);
    const node = findToolNode(turns, 'agent-1');
    expect(node?.kind).toBe('spawn-subagent-tool-call');
    expect(toolFeedEntries(node && 'children' in node ? (node.children ?? []) : [])).toEqual([
      {
        kind: 'tool',
        id: 'item-read',
        title: 'Read',
        detail: 'src/index.ts',
        status: 'done',
        depth: 0,
      },
      {
        kind: 'tool',
        id: 'item-exec',
        title: 'Terminal',
        detail: 'pnpm test',
        status: 'running',
        depth: 0,
      },
    ]);
  });

  it('turns a worker conversation into a compact feed', () => {
    const feed = transcriptFeed([
      turn([
        { kind: 'message', id: 'm1', seq: 0, role: 'user', text: 'Testleri yaz' },
        {
          kind: 'thinking',
          id: 't1',
          seq: 1,
          segmentId: 's',
          text: '...',
          status: 'done',
          startedAt: 0,
        },
        nativeSubagent.children![1]!,
        { kind: 'message', id: 'm2', seq: 3, role: 'assistant', text: 'Bitti.' },
      ]),
    ]);
    expect(feed.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'message:m1',
      'tool:item-exec',
      'message:m2',
    ]);
  });

  it('links spawn calls to workers by description, then by order, skipping failed calls', () => {
    const turns = [
      turn([
        spawn('s1', 'done', 'Codex — testler'),
        spawn('s2', 'error', 'Claude — inceleme'),
        spawn('s3', 'done', 'Kimi — belgeler'),
        spawn('s4', 'running'),
      ]),
    ];
    const spawns = collectOrchestraSpawns(turns);
    expect(spawns.map((entry) => entry.toolCallId)).toEqual(['s1', 's2', 's3', 's4']);
    const links = matchOrchestraWorkers(spawns, [
      worker('w-docs', 2, 'Kimi — belgeler'),
      worker('w-tests', 1, 'Codex — testler'),
      worker('w-extra', 3),
    ]);
    expect(links.get('s1')?.workerId).toBe('w-tests');
    expect(links.get('s3')?.workerId).toBe('w-docs');
    expect(links.get('s4')?.workerId).toBe('w-extra');
    expect(links.has('s2')).toBe(false);
  });

  it('maps worker conversation status to a sub-agent phase', () => {
    expect(phaseFromAgentStatus('working')).toBe('running');
    expect(phaseFromAgentStatus('awaiting-input')).toBe('running');
    expect(phaseFromAgentStatus('completed')).toBe('completed');
    expect(phaseFromAgentStatus('error')).toBe('failed');
    expect(phaseFromAgentStatus(undefined)).toBeUndefined();
  });
});
