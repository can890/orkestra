/**
 * Orkestra conductor rows contract: worker launches render as sub-agent rows with an "İzle ›" link
 * and conductor tools get their Turkish labels, for both conductor providers. Transcripts are built
 * from raw ACP updates through the core parser:
 *
 *   Claude Code: `mcp__orkestra__<tool>`, kind `other`, `rawInput` = tool arguments.
 *   Codex (codex-acp 1.12): `mcp.orkestra.<tool>`, kind `execute`,
 *     `rawInput: { server, tool, arguments }`.
 */

import { DEFAULT_THEME } from '@core/theme';
import { AcpTranscriptParser } from '@orkestra/core/runtimes/acp/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { ChatCommands } from '@/index';
import { createChatState } from '@/state/chat-state';

type SessionUpdate = Parameters<AcpTranscriptParser['push']>[0];

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const spawnArguments = (description: string) => ({
  agent: 'codex',
  task: 'Self-contained brief.',
  title: description,
  difficulty: 'standard',
  reason: 'Uygun ajan.',
  description,
});

function codexMcpCall(
  toolCallId: string,
  tool: string,
  args: unknown,
  server = 'orkestra'
): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    sessionId: 'sess-1',
    toolCallId,
    kind: 'execute',
    title: `mcp.${server}.${tool}`,
    status: 'in_progress',
    rawInput: { server, tool, arguments: args },
    _meta: { is_mcp_tool_call: true },
  } as unknown as SessionUpdate;
}

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

function userChunk(text: string): SessionUpdate {
  return {
    sessionUpdate: 'user_message_chunk',
    sessionId: 'sess-1',
    messageId: 'u1',
    content: { type: 'text', text },
  } as unknown as SessionUpdate;
}

function mount(updates: SessionUpdate[], commands: ChatCommands) {
  const parser = new AcpTranscriptParser({ conversationId: 'conv-1' });
  parser.push(userChunk('İşi işçilere dağıt'));
  for (const update of updates) parser.push(update);
  parser.endTurn();

  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([...parser.history]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:700px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, commands });

  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return host;
}

function workerLinks(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-subagent-open]')];
}

describe('Orkestra conductor rows contract', () => {
  it('shows Codex worker launches as watchable Orkestra worker rows', async () => {
    const onOpenSubagent = vi.fn();
    const host = mount(
      [
        codexMcpCall('call-1', 'spawn_agent', spawnArguments('Codex — testler')),
        codexMcpCall('call-2', 'spawn_agent', spawnArguments('Kimi — belgeler')),
        codexMcpCall('call-3', 'wait_for_agents', { mode: 'all' }),
      ],
      {
        onOpenSubagent,
        resolveSubagentPhase: ({ toolCallId }) =>
          toolCallId === 'call-1' ? 'completed' : undefined,
      }
    );
    await nextPaint();

    const links = workerLinks(host);
    expect(
      links.map((link) => [
        link.dataset.subagentToolCallId,
        link.dataset.subagentName,
        link.dataset.subagentSource,
        link.textContent,
      ])
    ).toEqual([
      ['call-1', 'Codex — testler', 'orchestra-worker', 'İzle ›'],
      ['call-2', 'Kimi — belgeler', 'orchestra-worker', 'İzle ›'],
    ]);
    expect(host.textContent).toContain('Orkestra işçisi · Tamamlandı');
    expect(host.textContent).toContain('Orkestra işçisi · Çalışıyor');
    expect(host.textContent).toContain('İşçileri bekle');
    expect(host.textContent).not.toContain('mcp.orkestra');

    links[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onOpenSubagent).toHaveBeenCalledWith({
      itemId: expect.any(String),
      toolCallId: 'call-2',
      name: 'Kimi — belgeler',
      source: 'orchestra-worker',
    });
  });

  it('keeps other Codex MCP calls as commands', async () => {
    const host = mount([codexMcpCall('call-1', 'list_issues', { team: 'ENG' }, 'linear')], {
      onOpenSubagent: vi.fn(),
    });
    await nextPaint();

    expect(workerLinks(host)).toEqual([]);
    expect(host.textContent).toContain('mcp.linear.list_issues');
  });

  it('keeps showing Claude Code worker launches as Orkestra worker rows', async () => {
    const host = mount(
      [
        claudeMcpCall('call-1', 'spawn_agent', spawnArguments('Claude — inceleme')),
        claudeMcpCall('call-2', 'wait_for_agents', {}),
      ],
      { onOpenSubagent: vi.fn() }
    );
    await nextPaint();

    expect(
      workerLinks(host).map((link) => [link.dataset.subagentName, link.dataset.subagentSource])
    ).toEqual([['Claude — inceleme', 'orchestra-worker']]);
    expect(host.textContent).toContain('İşçileri bekle');
  });
});
