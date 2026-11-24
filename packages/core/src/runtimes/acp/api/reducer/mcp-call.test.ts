import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { ToolCallItem, TranscriptItem } from '../models/turns';
import { AcpTranscriptParser } from './parser';

function update(value: Record<string, unknown>): SessionUpdate {
  return { sessionId: 'sess-1', ...value } as unknown as SessionUpdate;
}

function tools(items: readonly TranscriptItem[]): ToolCallItem[] {
  return items.filter((item): item is ToolCallItem => 'toolCallId' in item);
}

function lastItems(parser: AcpTranscriptParser): readonly TranscriptItem[] {
  return parser.activeTurn?.items ?? parser.history.at(-1)?.items ?? [];
}

describe('MCP call capture in the transcript', () => {
  it('keeps the identity, input and result of a Claude MCP call across updates', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c1' });
    parser.push(
      update({
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'weather?' },
      })
    );
    parser.push(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_1',
        title: 'mcp__weather__get_forecast',
        kind: 'other',
        status: 'pending',
        rawInput: { city: 'Oslo' },
        _meta: { claudeCode: { toolName: 'mcp__weather__get_forecast' } },
      })
    );
    parser.push(
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'in_progress' })
    );
    parser.push(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_1',
        status: 'completed',
        rawOutput: [{ type: 'text', text: 'Sunny' }],
        _meta: { claudeCode: { toolName: 'mcp__weather__get_forecast' } },
      })
    );
    const [tool] = tools(lastItems(parser));
    expect(tool?.status).toBe('done');
    expect(tool?.mcpCall).toEqual({
      server: 'weather',
      tool: 'get_forecast',
      input: { city: 'Oslo' },
      result: { content: [{ type: 'text', text: 'Sunny' }] },
    });
  });

  it('does not attach anything to ordinary tools', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'c1' });
    parser.push(
      update({
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'ls' },
      })
    );
    parser.push(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'ls' },
        _meta: { claudeCode: { toolName: 'Bash' } },
      })
    );
    const [tool] = tools(lastItems(parser));
    expect(tool).toBeDefined();
    expect(tool?.mcpCall).toBeUndefined();
  });
});
