import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { describe, expect, it } from 'vitest';
import { enrichClaudeUpdate } from '../impl/claude/acp-transform';
import { enrichCodexUpdate } from '../impl/codex/acp-enrich';
import { parseSubagentToolOutput } from './subagent-output';

describe('parseSubagentToolOutput', () => {
  it('extracts structured JSON response, metadata, and activities from MCP content array', () => {
    const payload = {
      ok: true,
      runId: 'run-123',
      provider: 'codex',
      model: 'GPT-6.2 Sol',
      effort: 'low',
      role: 'Codex Alt Ajan',
      response: 'Selam! '.repeat(120).trim(),
      activities: [
        { id: 'cmd-1', kind: 'tool', title: 'Komut çalıştırıldı', detail: 'ls', status: 'done' },
      ],
    };

    const parsed = parseSubagentToolOutput({
      rawOutput: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    });

    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-123',
      provider: 'codex',
      model: 'GPT-6.2 Sol',
      effort: 'low',
      role: 'Codex Alt Ajan',
      activities: [
        { id: 'cmd-1', kind: 'tool', title: 'Komut çalıştırıldı', detail: 'ls', status: 'done' },
      ],
    });
    expect(parsed?.summary?.length).toBeGreaterThan(500);
  });

  it('captures error text when ok is false', () => {
    const parsed = parseSubagentToolOutput({
      rawOutput: JSON.stringify({
        ok: false,
        runId: 'run-err',
        error: 'Oturum süresi doldu.',
      }),
    });

    expect(parsed).toEqual({
      ok: false,
      runId: 'run-err',
      error: 'Oturum süresi doldu.',
      summary: 'Oturum süresi doldu.',
    });
  });

  it('feeds complete summary into AcpTranscriptParser for Claude run_subagent updates', () => {
    const parser = new AcpTranscriptParser({
      conversationId: 'conv-claude',
      enrich: enrichClaudeUpdate,
    });
    const start: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_01',
      title: 'mcp__orkestra-subagents__run_subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: {
        provider: 'antigravity',
        model: 'gemini-4-neon-low',
        effort: 'low',
        prompt: 'Sadece "selam" yaz, başka bir şey yapma.',
      },
      _meta: { claudeCode: { toolName: 'mcp__orkestra-subagents__run_subagent' } },
    } as unknown as SessionUpdate;
    const end: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_01',
      status: 'completed',
      rawOutput: JSON.stringify({
        ok: true,
        runId: 'run-agy-1',
        provider: 'antigravity',
        model: 'Gemini 4 Neon (Düşük)',
        effort: 'low',
        role: 'Antigravity Alt Ajan',
        response: 'selam',
        activities: [{ id: 'tool-1', kind: 'status', title: 'Tamamlandı', status: 'done' }],
      }),
      _meta: { claudeCode: { toolName: 'mcp__orkestra-subagents__run_subagent' } },
    } as unknown as SessionUpdate;

    parser.push(start, 100);
    parser.push(end, 200);

    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({
      agentId: 'run-agy-1',
      toolCallId: 'toolu_01',
      status: 'completed',
      prompt: 'Sadece "selam" yaz, başka bir şey yapma.',
      summary: 'selam',
      provider: 'antigravity',
      model: 'Gemini 4 Neon (Düşük)',
      activities: [{ id: 'tool-1', kind: 'status', title: 'Tamamlandı', status: 'done' }],
    });
  });

  it('feeds complete summary into AcpTranscriptParser for Codex run_subagent updates even without repeated title', () => {
    const parser = new AcpTranscriptParser({
      conversationId: 'conv-codex',
      enrich: enrichCodexUpdate,
    });
    const start: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'mcp__orkestra-subagents__run_subagent',
      kind: 'other',
      status: 'in_progress',
      rawInput: {
        provider: 'claude',
        model: 'claude-opus-5-5',
        role: 'Analist',
        prompt: 'Durumu özetle.',
      },
    } as unknown as SessionUpdate;
    const end: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              runId: 'run-claude-1',
              provider: 'claude',
              model: 'Claude Opus 5.5',
              response: 'Tüm testler yeşil ve hazır.',
            }),
          },
        },
      ],
    } as unknown as SessionUpdate;

    parser.push(start, 100);
    parser.push(end, 200);

    expect(parser.agents).toHaveLength(1);
    expect(parser.agents[0]).toMatchObject({
      agentId: 'run-claude-1',
      toolCallId: 'call_1',
      status: 'completed',
      prompt: 'Durumu özetle.',
      summary: 'Tüm testler yeşil ve hazır.',
      provider: 'claude',
      model: 'Claude Opus 5.5',
    });
  });
});
