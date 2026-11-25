import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { AcpPermissionRequest, ToolNode, ToolStatus, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';
import { textShimmer } from '@styles/effects.css';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function execute(id: string, status: ToolStatus): Extract<ToolNode, { toolCallId: string }> {
  return {
    kind: 'execute-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: id,
    command: id,
    status,
  };
}

function permissionFor(toolCall: Extract<ToolNode, { toolCallId: string }>): AcpPermissionRequest {
  return {
    requestId: `request-${toolCall.toolCallId}`,
    toolCall,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

async function mountGroup(children: ToolNode[], permissions: AcpPermissionRequest[] = []) {
  const context = createChatContext();
  const state = createChatState(context);
  const group: Extract<ToolNode, { kind: 'tool-group' }> = {
    kind: 'tool-group',
    id: 'group',
    seq: 0,
    label: 'Tool run',
    groupKind: 'tool-run',
    status: children.some((child) => child.status === 'running')
      ? 'running'
      : children.some((child) => child.status === 'error')
        ? 'error'
        : 'done',
    children,
  };
  const turn: TranscriptTurn = {
    id: 'turn-1',
    seq: 0,
    initiator: 'agent',
    items: [group],
  };
  state.session.setPermissions(permissions);
  state.transcript.history.seed([turn]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host });

  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });

  await nextPaint();
  const header = host.querySelector<HTMLElement>('[data-collapse-id="group"]');
  if (!header) throw new Error('Tool group header did not render');
  const label = header.firstElementChild;
  if (!(label instanceof HTMLElement)) throw new Error('Tool group label did not render');
  return { header, label };
}

describe('tool-group status contract', () => {
  it('shows permission without shimmering when all running work is blocked', async () => {
    const blocked = execute('blocked', 'running');
    const { header, label } = await mountGroup(
      [execute('done', 'done'), blocked],
      [permissionFor(blocked)]
    );

    expect(header.querySelector('[aria-label="awaiting permission"]')).not.toBeNull();
    expect(label.classList.contains(textShimmer)).toBe(false);
  });

  it('shows both permission and activity when another child is running', async () => {
    const blocked = execute('blocked', 'running');
    const { header, label } = await mountGroup(
      [execute('active', 'running'), blocked],
      [permissionFor(blocked)]
    );

    expect(header.querySelector('[aria-label="awaiting permission"]')).not.toBeNull();
    expect(label.classList.contains(textShimmer)).toBe(true);
  });

  it('shows a completed child failure on the collapsed header', async () => {
    const { header } = await mountGroup([execute('failed', 'error'), execute('done', 'done')]);

    expect(header.querySelector('[aria-label="error"]')).not.toBeNull();
  });

  it('shows both failure and activity while another child is running', async () => {
    const { header, label } = await mountGroup([
      execute('failed', 'error'),
      execute('active', 'running'),
    ]);

    expect(header.querySelector('[aria-label="error"]')).not.toBeNull();
    expect(label.classList.contains(textShimmer)).toBe(true);
  });
});

it('shows Codex command failures only inside the expanded activity', async () => {
  const context = createChatContext();
  const state = createChatState(context, { compactActivity: true });
  const thinking: Extract<TranscriptTurn['items'][number], { kind: 'thinking' }> = {
    kind: 'thinking',
    id: 'thought',
    seq: 0,
    segmentId: 'reasoning',
    text: 'Check the build.',
    status: 'done',
    startedAt: 1,
  };
  state.transcript.history.seed([
    {
      id: 'codex-turn',
      seq: 0,
      initiator: 'agent',
      items: [
        thinking,
        execute('command-one', 'error'),
        { id: 'reply', kind: 'message', role: 'assistant', seq: 1, text: 'The build failed.' },
      ],
    },
  ]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });

  await nextPaint();
  const header = host.querySelector<HTMLElement>('[data-collapse-id="thought:activity"]')!;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent).toContain('The build failed.');
  expect(host.textContent).not.toContain('command-one');
  expect(host.querySelector('[aria-label="error"]')).toBeNull();

  header.click();
  await nextPaint();
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('[data-collapse-id="thought"]')).not.toBeNull();
  const command = host.querySelector('[data-collapse-id="command-one"]');
  expect(command?.querySelector('[aria-label="error"]')).not.toBeNull();
  expect(header.querySelector('[aria-label="error"]')).toBeNull();
});
