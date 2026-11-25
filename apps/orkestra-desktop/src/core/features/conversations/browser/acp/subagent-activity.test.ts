import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { ToolNode, TranscriptTurn } from '@orkestra/chat-ui';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import type { OrchestraWorkerSummary } from '@core/features/orchestra/api/orchestra';
import {
  buildAgentGraph,
  collectNativeSubagents,
  countGraphPhases,
  collectOrchestraSpawns,
  findToolNode,
  isOrchestraSpawnName,
  isOrchestraSpawnNode,
  matchOrchestraWorkers,
  nativeSubagentFeedEntries,
  nativeSubagentPhase,
  orchestraToolName,
  orchestraToolOf,
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

  it('builds a live agent diagram with nested sub-agents and Orkestra workers', () => {
    const nested: ToolNode = {
      ...nativeSubagent,
      id: 'item-outer',
      toolCallId: 'outer',
      name: 'Agent',
      inputSummary: 'Mimariyi incele',
      children: [
        nativeSubagent.children![0]!,
        { ...nativeSubagent, id: 'item-inner', toolCallId: 'inner', status: 'done' },
      ],
    };
    const graph = buildAgentGraph(
      [turn([nested, spawn('w1', 'done', 'Codex · GPT-6.1 Sol · zor — testler')])],
      { label: 'Karar verici', detail: 'Claude Code · Fable 5.1', phase: 'running' },
      new Map([['w1', { detail: 'Codex · GPT-6.1 Sol · zor', phase: 'completed' as const }]])
    );
    expect(graph.label).toBe('Karar verici');
    expect(graph.children.map((child) => [child.kind, child.label, child.phase])).toEqual([
      ['subagent', 'Mimariyi incele', 'running'],
      ['orchestra-worker', 'Codex · GPT-6.1 Sol · zor — testler', 'completed'],
    ]);
    const outer = graph.children[0]!;
    // Dış alt ajan yalnızca kendi adımını sayar; iç alt ajan ayrı düğümdür.
    expect(outer.steps).toBe(1);
    expect(outer.children.map((child) => [child.label, child.phase, child.steps])).toEqual([
      ['Kod tabanını tara', 'completed', 2],
    ]);
    expect(outer.children[0]!.currentStep).toBe('Terminal · pnpm test');
    expect(graph.children[1]!.detail).toBe('Codex · GPT-6.1 Sol · zor');
    expect(countGraphPhases(graph)).toEqual({
      spawning: 0,
      running: 1,
      completed: 2,
      failed: 0,
      unknown: 0,
    });
  });

  it('never calls a sub-agent whose end was not reported completed', () => {
    expect(nativeSubagentPhase({ status: 'done', statusUnknown: true })).toBe('unknown');
    expect(nativeSubagentPhase({ status: 'done' })).toBe('completed');
  });
});

/** Codex (codex-acp 1.12) reports the conductor's MCP calls as execute calls. */
const codexSpawn = (
  id: string,
  status: 'running' | 'done' | 'error',
  inputSummary?: string
): Extract<ToolNode, { kind: 'execute-tool-call' }> => ({
  kind: 'execute-tool-call',
  id: `item-${id}`,
  seq: 0,
  toolCallId: id,
  title: 'mcp.orkestra.spawn_agent',
  command: 'mcp.orkestra.spawn_agent',
  status,
  ...(inputSummary ? { inputSummary } : {}),
});

const spawnArguments = (description: string) => ({
  agent: 'codex',
  task: 'Self-contained brief.',
  title: description,
  difficulty: 'standard',
  reason: 'Uygun ajan.',
  description,
});

/** codex-acp `createMcpToolCallUpdate`: kind `execute`, `rawInput: { server, tool, arguments }`. */
function codexMcpCall(toolCallId: string, tool: string, args: unknown): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    sessionId: 'sess-1',
    toolCallId,
    kind: 'execute',
    title: `mcp.orkestra.${tool}`,
    status: 'in_progress',
    rawInput: { server: 'orkestra', tool, arguments: args },
    _meta: { is_mcp_tool_call: true },
  } as unknown as SessionUpdate;
}

/** codex-acp completion of an `mcpToolCall` item. */
function codexMcpCallDone(
  toolCallId: string,
  tool: string,
  args: unknown,
  status: 'completed' | 'failed'
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    sessionId: 'sess-1',
    toolCallId,
    status,
    rawInput: { server: 'orkestra', tool, arguments: args },
    rawOutput: { result: null, error: status === 'failed' ? { message: 'x' } : null },
  } as unknown as SessionUpdate;
}

/** claude-agent-acp: kind `other`, title `mcp__orkestra__<tool>`, `rawInput` = the arguments. */
function claudeMcpCall(toolCallId: string, tool: string, input: unknown): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    sessionId: 'sess-1',
    toolCallId,
    title: `mcp__orkestra__${tool}`,
    kind: 'other',
    status: 'pending',
    rawInput: input,
    content: [],
  } as unknown as SessionUpdate;
}

function claudeMcpCallDone(toolCallId: string, status: 'completed' | 'failed'): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    sessionId: 'sess-1',
    toolCallId,
    status,
  } as unknown as SessionUpdate;
}

/** Conductor transcript after feeding raw ACP updates through the core parser. */
function conductorTurns(updates: SessionUpdate[]): TranscriptTurn[] {
  const parser = new AcpTranscriptParser({ conversationId: 'conductor' });
  parser.push({
    sessionUpdate: 'user_message_chunk',
    sessionId: 'sess-1',
    messageId: 'u1',
    content: { type: 'text', text: 'İşi işçilere dağıt' },
  } as unknown as SessionUpdate);
  for (const update of updates) parser.push(update);
  return transcriptTurns({ displayTurns: parser.history, activeTurnSnapshot: parser.activeTurn });
}

const TESTS = 'Codex · GPT-6 Astra · standart — API testleri';
const DOCS = 'Kimi · K2 · basit — belgeler';
const REVIEW = 'Claude · Opus · zor — inceleme';

const CODEX_CONDUCTOR: SessionUpdate[] = [
  codexMcpCall('call-1', 'spawn_agent', spawnArguments(TESTS)),
  codexMcpCallDone('call-1', 'spawn_agent', spawnArguments(TESTS), 'completed'),
  codexMcpCall('call-2', 'spawn_agent', spawnArguments(DOCS)),
  codexMcpCallDone('call-2', 'spawn_agent', spawnArguments(DOCS), 'failed'),
  codexMcpCall('call-3', 'spawn_agent', spawnArguments(REVIEW)),
  codexMcpCall('call-4', 'wait_for_agents', { mode: 'all' }),
];

const CLAUDE_CONDUCTOR: SessionUpdate[] = [
  claudeMcpCall('call-1', 'spawn_agent', spawnArguments(TESTS)),
  claudeMcpCallDone('call-1', 'completed'),
  claudeMcpCall('call-2', 'spawn_agent', spawnArguments(DOCS)),
  claudeMcpCallDone('call-2', 'failed'),
  claudeMcpCall('call-3', 'spawn_agent', spawnArguments(REVIEW)),
  claudeMcpCall('call-4', 'wait_for_agents', { mode: 'all' }),
];

describe('Orkestra spawn detection across providers', () => {
  it('recognizes every provider spelling of the Orkestra tools', () => {
    for (const name of [
      'mcp__orkestra__spawn_agent',
      'mcp.orkestra.spawn_agent',
      'orkestra__spawn_agent',
      'orkestra.spawn_agent',
      'orkestra:spawn_agent',
    ]) {
      expect(isOrchestraSpawnName(name)).toBe(true);
    }
    expect(orchestraToolName('mcp.orkestra.wait_for_agents')).toBe('wait_for_agents');
    for (const name of [
      'mcp.orkestra.wait_for_agents',
      'mcp.linear.spawn_agent',
      'spawn_agent',
      'mcp__orkestra__spawn_agent_v2',
      'xorkestra.spawn_agent',
    ]) {
      expect(isOrchestraSpawnName(name)).toBe(false);
    }
  });

  it('detects spawn calls by server and tool, whatever the tool kind', () => {
    expect(isOrchestraSpawnNode(spawn('c', 'running'))).toBe(true);
    expect(isOrchestraSpawnNode(codexSpawn('x', 'running'))).toBe(true);
    expect(
      isOrchestraSpawnNode({
        kind: 'mcp-tool-call',
        id: 'item-m',
        seq: 0,
        toolCallId: 'm',
        title: 'spawn_agent',
        status: 'running',
        server: 'orkestra',
        tool: 'spawn_agent',
      })
    ).toBe(true);
    expect(
      orchestraToolOf({ ...codexSpawn('w', 'done'), title: 'mcp.orkestra.cancel_agent' })
    ).toBe('cancel_agent');
    expect(isOrchestraSpawnNode({ ...codexSpawn('l', 'done'), title: 'mcp.linear.list' })).toBe(
      false
    );
    expect(isOrchestraSpawnNode(nativeSubagent)).toBe(false);
  });

  it('links Codex spawn calls inside a command group to workers', () => {
    const group: ToolNode = {
      kind: 'tool-group',
      id: 'group',
      seq: 0,
      label: 'Ran 3 commands',
      groupKind: 'tool-run',
      status: 'running',
      children: [
        codexSpawn('s1', 'done', 'Codex — testler'),
        codexSpawn('s2', 'error', 'Claude — inceleme'),
        codexSpawn('s3', 'running'),
      ],
    };
    const spawns = collectOrchestraSpawns([turn([group])]);
    expect(spawns.map((entry) => [entry.toolCallId, entry.status, entry.inputSummary])).toEqual([
      ['s1', 'done', 'Codex — testler'],
      ['s2', 'error', 'Claude — inceleme'],
      ['s3', 'running', undefined],
    ]);
    const links = matchOrchestraWorkers(spawns, [
      worker('w-extra', 2),
      worker('w-tests', 1, 'Codex — testler'),
    ]);
    expect(links.get('s1')?.workerId).toBe('w-tests');
    expect(links.get('s3')?.workerId).toBe('w-extra');
    expect(links.has('s2')).toBe(false);
  });

  for (const [provider, updates] of [
    ['Codex', CODEX_CONDUCTOR],
    ['Claude Code', CLAUDE_CONDUCTOR],
  ] as const) {
    it(`links a ${provider} conductor's workers from raw ACP updates`, () => {
      const turns = conductorTurns(updates);
      const spawns = collectOrchestraSpawns(turns);
      expect(spawns.map((entry) => [entry.toolCallId, entry.status, entry.inputSummary])).toEqual([
        ['call-1', 'done', TESTS],
        ['call-2', 'error', DOCS],
        ['call-3', 'running', REVIEW],
      ]);

      const links = matchOrchestraWorkers(spawns, [
        worker('w-review', 2, REVIEW),
        worker('w-tests', 1, TESTS),
      ]);
      expect(links.get('call-1')?.workerId).toBe('w-tests');
      expect(links.get('call-3')?.workerId).toBe('w-review');
      expect(links.has('call-2')).toBe(false);

      const graph = buildAgentGraph(
        turns,
        { label: 'Karar verici', phase: 'running' },
        new Map([['call-1', { phase: 'completed' as const }]])
      );
      expect(graph.children.map((child) => [child.kind, child.label, child.phase])).toEqual([
        ['orchestra-worker', TESTS, 'completed'],
        ['orchestra-worker', DOCS, 'failed'],
        ['orchestra-worker', REVIEW, 'spawning'],
      ]);
    });
  }
});

describe('Antigravity swarm member rows', () => {
  const memberCall = (status: string, extra: Record<string, unknown> = {}) =>
    ({
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-3',
      title: 'scout · Gemini 4 Argon (Yüksek)',
      kind: 'subagent',
      status,
      rawInput: { action: 'add', name: 'scout', description: 'Depoyu tara ve raporla' },
      ...extra,
    }) as unknown as SessionUpdate;

  it('shows the given task and the member reply on the sub-agent feed', () => {
    const turns = conductorTurns([
      memberCall('in_progress'),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agy-3',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: '@coordinator [done] Hazır' } },
        ],
      } as unknown as SessionUpdate,
    ]);
    const node = findToolNode(turns, 'agy-3');
    expect(node?.kind).toBe('spawn-subagent-tool-call');
    expect(collectNativeSubagents(turns)).toEqual([
      expect.objectContaining({ name: 'scout · Gemini 4 Argon (Yüksek)', phase: 'completed' }),
    ]);
    expect(node && nativeSubagentFeedEntries(node)).toEqual([
      expect.objectContaining({ kind: 'message', role: 'user', text: 'Depoyu tara ve raporla' }),
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        text: '@coordinator [done] Hazır',
      }),
    ]);
  });

  it('shows only the task until the member replies', () => {
    const node = findToolNode(conductorTurns([memberCall('in_progress')]), 'agy-3');
    expect(node && nativeSubagentFeedEntries(node)).toEqual([
      expect.objectContaining({ kind: 'message', role: 'user' }),
    ]);
  });
});

describe('tool group titles in the sub-agent feed', () => {
  it('shows the Turkish summary instead of the English label sent as data', () => {
    const group: ToolNode = {
      kind: 'tool-group',
      id: 'group',
      seq: 0,
      label: 'Ran 3 commands',
      groupKind: 'tool-run',
      status: 'done',
      children: [codexSpawn('s1', 'done'), codexSpawn('s2', 'done'), codexSpawn('s3', 'done')],
    };
    expect(toolFeedEntries([group])[0]).toMatchObject({ title: '3 komut çalıştırıldı' });
  });
});

describe('restored background agents in the running chip and graph', () => {
  const AGENT = 'a0000000000000123';
  const OTHER = 'a0000000000000456';

  /**
   * Geri yüklenen oturum: iki ajan başlatılır; A'nın tek görünen bitişi onu yeniden başlatan
   * `SendMessage` çağrısının kimliğini taşır, B'nin akıbeti bilinmez.
   */
  function restoredTurns(): TranscriptTurn[] {
    const p = new AcpTranscriptParser({ conversationId: 'restored' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'başlat' }, 1);
    for (const [toolCallId, agentId] of [
      ['toolu_a', AGENT],
      ['toolu_b', OTHER],
    ] as const) {
      p.pushEvent(
        {
          kind: 'subagent',
          toolCallId,
          title: `lane ${toolCallId}`,
          status: 'in_progress',
          parentToolCallId: null,
          background: true,
          agentId,
        },
        2
      );
    }
    p.endTurn(3);
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u2', text: 'devam' }, 4);
    p.pushEvent(
      {
        kind: 'tool_call',
        toolCallId: 'toolu_send',
        title: 'SendMessage',
        toolKind: 'other',
        status: 'pending',
        parentToolCallId: null,
        diffs: [],
        locations: [],
      },
      5
    );
    p.pushEvent(
      {
        kind: 'tool_update',
        toolCallId: 'toolu_send',
        status: 'completed',
        parentToolCallId: null,
        resumesAgentId: AGENT,
      },
      6
    );
    p.endTurn(7);
    p.pushEvent(
      { kind: 'subagent_update', agentId: AGENT, toolCallId: 'toolu_send', status: 'completed' },
      8
    );
    p.pushEvent(
      {
        kind: 'subagent_update',
        agentId: OTHER,
        toolCallId: 'toolu_b',
        status: 'completed',
        statusUnknown: true,
      },
      9
    );
    return [...p.history] as TranscriptTurn[];
  }

  it('counts no agent as running once every completion or unknown outcome arrived', () => {
    const turns = restoredTurns();
    const subagents = collectNativeSubagents(turns);
    expect(subagents.map((agent) => [agent.toolCallId, agent.phase])).toEqual([
      ['toolu_a', 'completed'],
      ['toolu_b', 'unknown'],
    ]);
    expect(subagents.filter((agent) => agent.phase === 'running')).toEqual([]);
    const counts = countGraphPhases(
      buildAgentGraph(turns, { label: 'Ana ajan', phase: 'completed' })
    );
    expect(counts).toMatchObject({ running: 0, spawning: 0, completed: 1, unknown: 1 });
  });
});
