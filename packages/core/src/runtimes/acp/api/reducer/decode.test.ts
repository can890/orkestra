/**
 * Decoder tests for tool-call input summaries, including the MCP payload shapes
 * of the two providers that run the Orkestra conductor:
 *
 *   Claude Code (claude-agent-acp): kind `other`, title `mcp__<server>__<tool>`,
 *     `rawInput` is the tool arguments.
 *   Codex (codex-acp 1.12): kind `execute`, title `mcp.<server>.<tool>`,
 *     `rawInput: { server, tool, arguments }`, `_meta.is_mcp_tool_call`.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { ToolNode, TranscriptItem } from '../models/turns';
import { decodeSessionUpdate } from './decode';
import { AcpTranscriptParser } from './parser';

const SPAWN_DESCRIPTION = 'Codex · GPT-6 Astra · standart — API testlerini yaz';

const spawnArguments = (description: string = SPAWN_DESCRIPTION) => ({
  agent: 'codex',
  task: 'Write integration tests for the HTTP API in src/api.',
  title: 'API testleri',
  difficulty: 'standard',
  reason: 'Test yazımında en hızlı ajan.',
  description,
});

/** codex-acp `createMcpToolCallUpdate` (item/started, and history replay with a final status). */
function codexMcpCall(
  toolCallId: string,
  tool: string,
  args: unknown,
  status: 'in_progress' | 'completed' | 'failed' = 'in_progress'
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    sessionId: 'sess-1',
    toolCallId,
    kind: 'execute',
    title: `mcp.orkestra.${tool}`,
    status,
    rawInput: { server: 'orkestra', tool, arguments: args },
    _meta: { is_mcp_tool_call: true },
  } as unknown as SessionUpdate;
}

/** codex-acp `completeItemEvent` for an `mcpToolCall` item (item/completed). */
function codexMcpCallCompleted(
  toolCallId: string,
  tool: string,
  args: unknown,
  status: 'completed' | 'failed' = 'completed'
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    sessionId: 'sess-1',
    toolCallId,
    status,
    rawInput: { server: 'orkestra', tool, arguments: args },
    rawOutput:
      status === 'completed'
        ? { result: { content: [{ type: 'text', text: '{"worker_id":"w-1"}' }] }, error: null }
        : { result: null, error: { message: 'unknown agent' } },
  } as unknown as SessionUpdate;
}

/** claude-agent-acp tool call for an MCP tool (`toolInfoFromToolUse` default branch). */
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
    _meta: { claudeCode: { toolName: `mcp__orkestra__${tool}` } },
  } as unknown as SessionUpdate;
}

function userChunk(messageId: string, text: string): SessionUpdate {
  return {
    sessionUpdate: 'user_message_chunk',
    sessionId: 'sess-1',
    messageId,
    content: { type: 'text', text },
  } as unknown as SessionUpdate;
}

function toolCall(rawInput: unknown): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    sessionId: 'sess-1',
    toolCallId: 'tool-1',
    kind: 'execute',
    title: 'mcp.linear.create_issue',
    status: 'in_progress',
    rawInput,
  } as unknown as SessionUpdate;
}

function inputSummaryOf(update: SessionUpdate): string | undefined {
  const event = decodeSessionUpdate(update);
  if (event.kind !== 'tool_call' && event.kind !== 'tool_update') {
    throw new Error(`unexpected event kind ${event.kind}`);
  }
  return event.inputSummary;
}

function toolNodes(items: readonly TranscriptItem[] | undefined): ToolNode[] {
  const nodes: ToolNode[] = [];
  const visit = (node: ToolNode) => {
    nodes.push(node);
    for (const child of ('children' in node ? node.children : undefined) ?? []) visit(child);
  };
  for (const item of items ?? []) {
    if (item.kind !== 'message' && item.kind !== 'thinking') visit(item);
  }
  return nodes;
}

describe('decodeSessionUpdate – tool input summary', () => {
  it('reads the description from Codex MCP arguments on the initial tool_call', () => {
    expect(decodeSessionUpdate(codexMcpCall('call-1', 'spawn_agent', spawnArguments()))).toEqual(
      expect.objectContaining({
        kind: 'tool_call',
        toolCallId: 'call-1',
        title: 'mcp.orkestra.spawn_agent',
        toolKind: 'execute',
        status: 'in_progress',
        inputSummary: SPAWN_DESCRIPTION,
      })
    );
  });

  it('reads the description from Codex MCP arguments on the completion update', () => {
    const event = decodeSessionUpdate(
      codexMcpCallCompleted('call-1', 'spawn_agent', spawnArguments())
    );
    expect(event).toEqual(
      expect.objectContaining({
        kind: 'tool_update',
        toolCallId: 'call-1',
        status: 'completed',
        inputSummary: SPAWN_DESCRIPTION,
      })
    );
    expect(event).not.toHaveProperty('title');
    expect(event).not.toHaveProperty('toolKind');
  });

  it('keeps reading Claude Code MCP descriptions from rawInput itself', () => {
    expect(
      inputSummaryOf(claudeMcpCall('call-1', 'spawn_agent', spawnArguments('Claude — inceleme')))
    ).toBe('Claude — inceleme');
  });

  it('prefers a direct rawInput description over wrapped arguments', () => {
    expect(
      inputSummaryOf(toolCall({ description: 'outer', arguments: { description: 'inner' } }))
    ).toBe('outer');
  });

  it('ignores wrapped descriptions that are not a one-line summary', () => {
    expect(
      inputSummaryOf(toolCall({ arguments: { title: 'Bug', description: 'Steps:\n1. open' } }))
    ).toBeUndefined();
    expect(inputSummaryOf(toolCall({ arguments: { description: '   ' } }))).toBeUndefined();
    expect(inputSummaryOf(toolCall({ arguments: { description: 42 } }))).toBeUndefined();
    expect(inputSummaryOf(toolCall({ arguments: '{"description":"x"}' }))).toBeUndefined();
    expect(inputSummaryOf(toolCall({ arguments: [{ description: 'x' }] }))).toBeUndefined();
    expect(inputSummaryOf(toolCall({ arguments: null }))).toBeUndefined();
  });

  it('accepts a one-line wrapped description with surrounding whitespace', () => {
    expect(inputSummaryOf(toolCall({ arguments: { description: ' Gist notları\n' } }))).toBe(
      ' Gist notları\n'
    );
  });

  it('leaves Codex shell commands without a summary', () => {
    expect(inputSummaryOf(toolCall({ command: 'pnpm test', cwd: '/repo' }))).toBeUndefined();
  });
});

describe('AcpTranscriptParser – Orkestra MCP calls', () => {
  it('keeps the Codex spawn description on the execute item through completion', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'conv-1' });
    parser.push(userChunk('u1', 'Testleri işçilere dağıt'));
    parser.push(codexMcpCall('call-1', 'spawn_agent', spawnArguments()));

    expect(toolNodes(parser.activeTurn?.items)).toEqual([
      expect.objectContaining({
        kind: 'execute-tool-call',
        toolCallId: 'call-1',
        title: 'mcp.orkestra.spawn_agent',
        command: 'mcp.orkestra.spawn_agent',
        inputSummary: SPAWN_DESCRIPTION,
        status: 'running',
      }),
    ]);

    parser.push(codexMcpCallCompleted('call-1', 'spawn_agent', spawnArguments()));
    expect(toolNodes(parser.activeTurn?.items)).toEqual([
      expect.objectContaining({
        kind: 'execute-tool-call',
        inputSummary: SPAWN_DESCRIPTION,
        status: 'done',
      }),
    ]);
  });

  it('groups consecutive Codex spawns with their own descriptions', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'conv-1' });
    parser.push(userChunk('u1', 'Dağıt'));
    parser.push(codexMcpCall('call-1', 'spawn_agent', spawnArguments('Codex — testler')));
    parser.push(codexMcpCall('call-2', 'spawn_agent', spawnArguments('Kimi — belgeler')));
    parser.push(
      codexMcpCallCompleted('call-2', 'spawn_agent', spawnArguments('Kimi — belgeler'), 'failed')
    );

    expect(parser.activeTurn?.items.map((item) => item.kind)).toEqual(['message', 'tool-group']);
    expect(
      toolNodes(parser.activeTurn?.items)
        .filter((node) => node.kind === 'execute-tool-call')
        .map((node) => [node.toolCallId, node.inputSummary, node.status])
    ).toEqual([
      ['call-1', 'Codex — testler', 'running'],
      ['call-2', 'Kimi — belgeler', 'error'],
    ]);
  });

  it('keeps the Claude Code spawn as an unknown tool with its description', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'conv-1' });
    parser.push(userChunk('u1', 'Dağıt'));
    parser.push(claudeMcpCall('call-1', 'spawn_agent', spawnArguments('Claude — inceleme')));

    expect(toolNodes(parser.activeTurn?.items)).toEqual([
      expect.objectContaining({
        kind: 'unknown-tool-call',
        name: 'mcp__orkestra__spawn_agent',
        inputSummary: 'Claude — inceleme',
      }),
    ]);
  });
});
