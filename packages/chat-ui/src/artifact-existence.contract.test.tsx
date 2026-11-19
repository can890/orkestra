import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { ChatCommands, TranscriptTurn } from './index';
import { createChatState } from './state/chat-state';

const cleanups: Array<() => void> = [];
const errors = vi.spyOn(console, 'error');
const dataImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=';
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  expect(errors).not.toHaveBeenCalled();
  errors.mockClear();
});

function mount(items: TranscriptTurn['items'], commands: ChatCommands = {}) {
  const context = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 'outputs', seq: 0, initiator: 'agent', items }]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:900px';
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

const card = (host: HTMLElement, name: string) =>
  host.querySelector(`section[aria-label="Output: ${name}"]`);
const message = (id: string, text: string, seq = 0): TranscriptTurn['items'][number] => ({
  kind: 'message',
  id,
  seq,
  role: 'assistant',
  text,
});

describe('tools that only consume content', () => {
  it.each(['read-tool-call', 'search-tool-call', 'web-fetch-tool-call'] as const)(
    '%s keeps data: artifacts and drops path references',
    async (kind) => {
      const host = mount([
        {
          kind,
          id: 'tool',
          seq: 0,
          toolCallId: 'tool',
          title: 'Tool',
          status: 'done',
          artifacts: [
            { uri: '/brand/hat-one-mark.png', name: 'path.png' },
            { uri: dataImage, name: 'bytes.png' },
          ],
        } as TranscriptTurn['items'][number],
      ]);
      await paint();
      expect(card(host, 'path.png')).toBeNull();
      expect(card(host, 'bytes.png')).not.toBeNull();
    }
  );

  it('still promotes artifacts of other tool kinds', async () => {
    const host = mount([
      {
        kind: 'unknown-tool-call',
        id: 'other',
        seq: 0,
        toolCallId: 'other',
        title: 'Make',
        toolKind: 'other',
        name: 'imagegen',
        status: 'done',
        artifacts: [{ uri: '/out/made.png', name: 'made.png' }],
      },
    ]);
    await paint();
    expect(card(host, 'made.png')).not.toBeNull();
  });
});

describe('path candidate existence gate', () => {
  const text = (name: string) => `![${name}](/brand/${name}.png)`;

  it('hides the card while unknown, shows it once the host confirms the file', async () => {
    let answer!: (exists: boolean) => void;
    const artifactExists = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const host = mount([message('m', text('pending'))], { artifactExists });
    await paint();
    expect(artifactExists).toHaveBeenCalledOnce();
    expect(card(host, 'pending')).toBeNull();
    answer(true);
    await paint();
    expect(card(host, 'pending')).not.toBeNull();
  });

  it('keeps the card hidden after a definitive false', async () => {
    const artifactExists = vi.fn(async () => false);
    const host = mount([message('m', text('gone'))], { artifactExists });
    await paint();
    await paint();
    expect(artifactExists).toHaveBeenCalledOnce();
    expect(card(host, 'gone')).toBeNull();
  });

  it('shows the card when the probe rejects', async () => {
    const artifactExists = vi.fn(async () => {
      throw new Error('ssh down');
    });
    const host = mount([message('m', text('flaky'))], { artifactExists });
    await paint();
    await paint();
    expect(card(host, 'flaky')).not.toBeNull();
  });

  it('shows the card when the host has no artifactExists command', async () => {
    const host = mount([message('m', text('plain'))]);
    await paint();
    expect(card(host, 'plain')).not.toBeNull();
  });

  it('probes each uri once and never probes embeddable artifacts', async () => {
    const artifactExists = vi.fn(async () => true);
    const host = mount(
      [
        message('a', text('shared'), 0),
        message('b', text('shared'), 1),
        {
          kind: 'message',
          id: 'c',
          seq: 2,
          role: 'assistant',
          text: '',
          artifacts: [
            { uri: dataImage, name: 'inline.png' },
            { uri: 'https://example.com/remote.png', name: 'remote.png' },
          ],
        },
      ],
      { artifactExists }
    );
    await paint();
    await paint();
    expect(artifactExists).toHaveBeenCalledOnce();
    expect(artifactExists).toHaveBeenCalledWith(
      expect.objectContaining({ uri: '/brand/shared.png' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(card(host, 'inline.png')).not.toBeNull();
    expect(card(host, 'remote.png')).not.toBeNull();
  });
});
