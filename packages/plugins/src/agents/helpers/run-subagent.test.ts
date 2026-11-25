/**
 * Orkestra'nın kendi `run_subagent` aracı hangi ajan çağırırsa çağırsın alt ajan paneline düşer.
 * Olaylar ve kimlikler sentetiktir.
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { EnrichHook } from '@orkestra/core/runtimes/acp/api';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { createCustomAcpProvider } from '../custom-acp/provider';
import { provider as glm } from '../impl/glm';
import { provider as grok } from '../impl/grok';
import { provider as kimi } from '../impl/kimi';
import { isRunSubagentToolName } from './run-subagent';

const RUN_ID = '0b6f8a52-3c1d-4e8f-9a7b-1c2d3e4f5a6b';

const customAgent = createCustomAcpProvider({
  id: 'acp-local-test',
  source: 'local',
  name: 'Test ACP',
  description: '',
  launch: { command: '/usr/local/bin/test-acp', args: [], env: {} },
  addedAt: 1,
});

const start = (title: string): SessionUpdate =>
  ({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_run',
    title,
    kind: 'other',
    status: 'in_progress',
    rawInput: { provider: 'codex', model: 'GPT Test Sol', prompt: 'Depoyu özetle.' },
  }) as unknown as SessionUpdate;

const end: SessionUpdate = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call_run',
  status: 'completed',
  content: [
    {
      type: 'content',
      content: {
        type: 'text',
        text: JSON.stringify({ ok: true, runId: RUN_ID, provider: 'codex', response: 'Özet.' }),
      },
    },
  ],
} as SessionUpdate;

function enrichOf(name: string): EnrichHook {
  const providers = { kimi, grok, glm, custom: customAgent } as const;
  const enrich = providers[name as keyof typeof providers].behavior.acp?.enrich;
  if (!enrich) throw new Error(`${name} has no enrich hook`);
  return enrich;
}

describe('run_subagent from non-Claude agents', () => {
  it.each([
    ['kimi', 'run_subagent'],
    ['grok', 'orkestra-subagents/run_subagent'],
    ['custom', 'orkestra-subagents.run_subagent'],
    ['glm', 'mcp__orkestra-subagents__run_subagent'],
  ])('%s shows a run_subagent call (%s) as a sub-agent card with its result', (name, title) => {
    const parser = new AcpTranscriptParser({
      conversationId: `conv-${name}`,
      enrich: enrichOf(name),
    });
    parser.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'alt ajan' }, 1);
    parser.push(start(title), 2);
    expect(parser.agents[0]).toMatchObject({
      toolCallId: 'call_run',
      status: 'running',
      provider: 'codex',
      model: 'GPT Test Sol',
      prompt: 'Depoyu özetle.',
    });
    parser.push(end, 3);
    expect(parser.agents[0]).toMatchObject({
      agentId: RUN_ID,
      status: 'completed',
      summary: 'Özet.',
    });
  });

  it('shows a GLM (Claude Code on Z.ai) Agent tool sub-agent with the GLM provider chip', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'conv-glm', enrich: enrichOf('glm') });
    parser.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: 'alt ajan' }, 1);
    parser.push(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_agent',
        title: 'Task',
        kind: 'think',
        status: 'pending',
        rawInput: { description: 'Depoyu tara', prompt: 'Depoyu tara.', subagent_type: 'Explore' },
        _meta: { claudeCode: { toolName: 'Agent' } },
      } as unknown as SessionUpdate,
      2
    );
    expect(parser.agents[0]).toMatchObject({
      toolCallId: 'toolu_agent',
      status: 'running',
      provider: 'glm',
      prompt: 'Depoyu tara.',
    });
  });

  it('recognises the tool name in every provider spelling and nothing else', () => {
    for (const name of [
      'run_subagent',
      'mcp__orkestra-subagents__run_subagent',
      'orkestra-subagents/run_subagent',
      'orkestra-subagents.run_subagent',
      'orkestra-subagents:run_subagent',
    ]) {
      expect(isRunSubagentToolName(name)).toBe(true);
    }
    for (const name of ['list_subagent_models', 'run_subagents', 'prerun_subagent', '']) {
      expect(isRunSubagentToolName(name)).toBe(false);
    }
  });
});
