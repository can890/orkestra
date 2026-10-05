import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from './chat-context';
import { createChatView } from './chat-view';
import type { ChatCommands, TranscriptTurn } from './index';
import { createChatState } from './state/chat-state';

const cleanups: Array<() => void> = [];
const errors = vi.spyOn(console, 'error');
const imageUrl =
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

describe('artifact previews', () => {
  it('contains tall images within the reserved row and keeps the next message below it', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 1500;
    const host = mount([
      {
        kind: 'message',
        id: 'portrait',
        seq: 0,
        role: 'assistant',
        text: '',
        artifacts: [{ uri: canvas.toDataURL('image/png'), name: 'portrait.png' }],
      },
      { kind: 'message', id: 'next', seq: 1, role: 'assistant', text: 'After preview' },
    ]);
    await paint();
    const card = host.querySelector('section[aria-label="Output: portrait.png"]')!;
    const image = host.querySelector('img[alt="portrait.png"]')!;
    const next = Array.from(host.querySelectorAll('*')).find(
      (element) => element.children.length === 0 && element.textContent === 'After preview'
    )!;
    expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(404);
    expect(image.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card.getBoundingClientRect().bottom
    );
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      card.getBoundingClientRect().bottom
    );
  });

  it('shows an image even when its tool group is collapsed', async () => {
    const host = mount([
      {
        kind: 'tool-group',
        id: 'tools',
        seq: 0,
        label: 'Tools',
        groupKind: 'tool-run',
        status: 'done',
        children: [
          {
            kind: 'unknown-tool-call',
            id: 'image',
            seq: 0,
            toolCallId: 'image',
            title: 'Generate cat',
            toolKind: 'other',
            name: 'imagegen',
            status: 'done',
            artifacts: [
              {
                uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=',
                name: 'cat.png',
              },
            ],
          },
        ],
      },
    ]);
    await paint();
    expect(host.querySelector('img[alt="cat.png"]')).not.toBeNull();
    expect(host.querySelector('a[download="cat.png"]')).not.toBeNull();
  });

  it('loads a workspace image through the host resolver and releases its URL', async () => {
    const dispose = vi.fn();
    const resolveArtifact = vi.fn(async () => ({ url: imageUrl, dispose }));
    const host = mount(
      [
        {
          kind: 'message',
          id: 'message',
          seq: 0,
          role: 'assistant',
          text: '![cat](/remote/cat.png)',
        },
      ],
      { resolveArtifact }
    );
    await paint();
    expect(resolveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ uri: '/remote/cat.png' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(host.querySelector('img[alt="cat"]')).not.toBeNull();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('loads video only after the preview action and renders controls', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    canvas.getContext('2d')?.fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const recorded = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    recorder.stop();
    await recorded;
    stream.getTracks().forEach((track) => track.stop());
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    cleanups.push(() => URL.revokeObjectURL(url));
    const resolveArtifact = vi.fn(async () => ({ url }));
    const host = mount(
      [{ kind: 'message', id: 'video', seq: 0, role: 'assistant', text: '[Video](out/movie.mp4)' }],
      { resolveArtifact }
    );
    await paint();
    expect(resolveArtifact).not.toHaveBeenCalled();
    const preview = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Önizle'
    );
    expect(preview).toBeDefined();
    preview?.click();
    await paint();
    expect(host.querySelector('video[controls]')).not.toBeNull();
  });

  it('shows missing-file errors instead of an empty preview', async () => {
    const host = mount(
      [
        {
          kind: 'message',
          id: 'missing',
          seq: 0,
          role: 'assistant',
          text: '![cat](/missing/cat.png)',
        },
      ],
      {
        resolveArtifact: async () => {
          throw new Error('Dosya bulunamadı');
        },
      }
    );
    await paint();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Dosya bulunamadı');
    expect(host.querySelector('img[alt="cat"]')).toBeNull();
  });
});
