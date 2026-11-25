import { DEFAULT_THEME } from '@core/theme';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
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
    expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(184);
    expect(image.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card.getBoundingClientRect().bottom
    );
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      card.getBoundingClientRect().bottom
    );
  });

  it('renders multiple images as a compact frameless gallery and PDFs as compact pills', async () => {
    const onViewImage = vi.fn();
    const imageUrl2 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const host = mount(
      [
        {
          kind: 'message',
          id: 'multi',
          seq: 0,
          role: 'assistant',
          text: '',
          artifacts: [
            { uri: imageUrl, name: 'one.png' },
            { uri: imageUrl2, name: 'two.png' },
            { uri: '/docs/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
          ],
        },
      ],
      { onViewImage }
    );
    await paint();
    const first = host.querySelector('section[aria-label="Output: one.png"]')!;
    const second = host.querySelector('section[aria-label="Output: two.png"]')!;
    const pdf = host.querySelector('section[aria-label="Output: report.pdf"]')!;
    expect(first.getBoundingClientRect().width).toBe(144);
    expect(first.getBoundingClientRect().height).toBe(108);
    expect(second.getBoundingClientRect().top).toBe(first.getBoundingClientRect().top);
    expect(pdf.getBoundingClientRect().height).toBeLessThanOrEqual(40);
    expect(host.textContent).not.toContain('Generated media');

    (host.querySelector('img[alt="two.png"]') as HTMLImageElement).click();
    expect(onViewImage).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 1,
        source: 'assistant-output',
        gallery: expect.arrayContaining([
          expect.objectContaining({ alt: 'one.png' }),
          expect.objectContaining({ alt: 'two.png' }),
        ]),
      })
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

  it('renders a file once when the tool output and the reply of the same turn both carry it', async () => {
    const host = mount([
      {
        kind: 'unknown-tool-call',
        id: 'generate',
        seq: 0,
        toolCallId: 'generate',
        title: 'Generate cat',
        toolKind: 'other',
        name: 'imagegen',
        status: 'done',
        artifacts: [{ uri: imageUrl, name: 'cat.png' }],
      },
      {
        kind: 'message',
        id: 'reply',
        seq: 1,
        role: 'assistant',
        text: 'Here is the cat.',
        artifacts: [{ uri: imageUrl, name: 'cat.png' }],
      },
    ]);
    await paint();
    const cards = host.querySelectorAll('section[aria-label="Output: cat.png"]');
    expect(cards).toHaveLength(1);
    const reply = Array.from(host.querySelectorAll('*')).find(
      (element) => element.children.length === 0 && element.textContent === 'Here is the cat.'
    )!;
    // The surviving card is the reply's, placed below the reply text.
    expect(cards[0].getBoundingClientRect().top).toBeGreaterThanOrEqual(
      reply.getBoundingClientRect().bottom
    );
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

  it('loads video only after the preview action and renders the player', async () => {
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
    await waitFor(() => host.querySelector('video[src]') !== null);
    // Our own player, never the browser's native control strip.
    expect(host.querySelector('video[controls]')).toBeNull();
    expect(host.querySelector('button[aria-label="Oynat: Video"]')).not.toBeNull();
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

  it('keeps small badge images comfortably sized and clickable across the card', async () => {
    const onViewImage = vi.fn();
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 20;
    const host = mount(
      [
        {
          kind: 'message',
          id: 'badge',
          seq: 0,
          role: 'assistant',
          text: '',
          artifacts: [{ uri: canvas.toDataURL('image/png'), name: 'badge.png' }],
        },
      ],
      { onViewImage }
    );
    await paint();

    const card = host.querySelector('section[aria-label="Output: badge.png"]') as HTMLElement;
    const rect = card.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(168);
    expect(rect.height).toBeGreaterThanOrEqual(112);
    expect(rect.height).toBeLessThanOrEqual(184);

    card.click();
    expect(onViewImage).toHaveBeenCalledTimes(1);

    const downloadLink = card.querySelector('a[download="badge.png"]') as HTMLAnchorElement;
    expect(downloadLink).not.toBeNull();
    downloadLink.addEventListener('click', (e) => e.preventDefault());
    downloadLink.click();
    expect(onViewImage).toHaveBeenCalledTimes(1);
  });

  it('plays a workspace video inline through the host stream URL, without a preview step', async () => {
    const url = await recordWebm();
    const dispose = vi.fn();
    const resolveArtifact = vi.fn(async () => ({ url }));
    const mediaUrlForArtifact = vi.fn(async () => ({
      url,
      size: Math.round(1.5 * 1024 ** 3),
      dispose,
    }));
    const onViewImage = vi.fn();
    const host = mount(
      [
        {
          kind: 'message',
          id: 'video',
          seq: 0,
          role: 'assistant',
          text: '[Render](out/final.mp4)',
        },
      ],
      { resolveArtifact, mediaUrlForArtifact, onViewImage }
    );
    await paint();
    await waitFor(() => host.querySelector('video[src]') !== null);
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(mediaUrlForArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'out/final.mp4' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Önizle')
    ).toBe(false);
    const video = host.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute('src')).toBe(`${url}#t=0.001`);
    expect(video.hasAttribute('controls')).toBe(false);
    const card = host.querySelector('section[aria-label="Output: Render"]') as HTMLElement;
    expect(card.textContent).toContain('1,5 GB');

    // Custom player: the large play button starts playback, then the control bar takes over.
    const bar = card.querySelector('[role="slider"]')!.parentElement as HTMLElement;
    expect(bar.dataset.visible).toBe('false');
    // Muted playback needs no user gesture in the test browser. The recorded clip is a single
    // frame, so playback ends right away: wait for the events rather than a playing state.
    video.muted = true;
    const played = new Promise<void>((resolve) =>
      video.addEventListener('play', () => resolve(), { once: true })
    );
    (card.querySelector('button[aria-label="Oynat: Render"]') as HTMLButtonElement).click();
    await played;
    await waitFor(() => video.paused);
    // Once started, the control bar stays up while paused.
    await waitFor(() => bar.dataset.visible === 'true');
    expect(card.querySelector('button[aria-label="Oynat"]')).not.toBeNull();
    (card.querySelector('button[aria-label="Sesi aç"]') as HTMLButtonElement).click();
    await waitFor(() => card.querySelector('button[aria-label="Sesi kapat"]') !== null);
    expect(video.muted).toBe(false);
    // 16:9 frame plus an info row: the aspect ratio is kept instead of a squashed grey box.
    const frame = video.parentElement as HTMLElement;
    const ratio = frame.getBoundingClientRect().width / frame.getBoundingClientRect().height;
    expect(ratio).toBeGreaterThan(0.9);
    // A streamed URL is never used as a download link.
    expect(card.querySelector(`a[href^="${url}"]`)).toBeNull();

    (card.querySelector('button[title="Büyüt"]') as HTMLButtonElement).click();
    expect(onViewImage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'video',
        gallery: [expect.objectContaining({ kind: 'video', src: undefined })],
      })
    );

    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(dispose).toHaveBeenCalledOnce();
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('plays audio through the custom player with a seekable waveform', async () => {
    const url = silentWavUrl(2);
    cleanups.push(() => URL.revokeObjectURL(url));
    const host = mount(
      [
        {
          kind: 'message',
          id: 'audio',
          seq: 0,
          role: 'assistant',
          text: '',
          artifacts: [{ uri: '/out/voice.mp3', name: 'voice.mp3', mimeType: 'audio/mpeg' }],
        },
        { kind: 'message', id: 'next', seq: 1, role: 'assistant', text: 'After audio' },
      ],
      { mediaUrlForArtifact: async () => ({ url, size: 2 * 1024 * 1024 }) }
    );
    await paint();
    const card = host.querySelector('section[aria-label="Output: voice.mp3"]') as HTMLElement;
    await waitFor(() => card.querySelector('audio[src]') !== null);
    const audio = card.querySelector('audio') as HTMLAudioElement;
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(card.textContent).toContain('MP3 · 2 MB');
    expect(card.querySelectorAll('[role="slider"] > span').length).toBe(48);
    await waitFor(() => card.textContent!.includes('0:02'));
    // A real click: unmuted audio needs a user gesture.
    await userEvent.click(card.querySelector('button[aria-label="Oynat: voice.mp3"]')!);
    await waitFor(() => card.querySelector('button[aria-label="Duraklat: voice.mp3"]') !== null);
    audio.pause();
    await waitFor(() => card.querySelector('button[aria-label="Oynat: voice.mp3"]') !== null);
    // Total duration shows next to the waveform once the metadata is known.
    expect(card.textContent).toContain('0:02');
    // The row height matches what the layout engine reserved for it.
    const next = Array.from(host.querySelectorAll('*')).find(
      (element) => element.children.length === 0 && element.textContent === 'After audio'
    )!;
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      card.getBoundingClientRect().bottom
    );
  });

  it('lays out several videos as an even 16:9 gallery', async () => {
    const url = await recordWebm();
    const host = mount(
      [
        {
          kind: 'message',
          id: 'videos',
          seq: 0,
          role: 'assistant',
          text: '',
          artifacts: [
            { uri: '/renders/a.mp4', name: 'a.mp4' },
            { uri: '/renders/b.mp4', name: 'b.mp4' },
            { uri: '/renders/c.mp4', name: 'c.mp4' },
          ],
        },
        { kind: 'message', id: 'next', seq: 1, role: 'assistant', text: 'After gallery' },
      ],
      { mediaUrlForArtifact: async () => ({ url, size: 1024 }) }
    );
    await paint();
    const tiles = ['a.mp4', 'b.mp4', 'c.mp4'].map(
      (name) => host.querySelector(`section[aria-label="Output: ${name}"]`) as HTMLElement
    );
    const [a, b, c] = tiles.map((tile) => tile.getBoundingClientRect());
    expect(a!.width).toBe(b!.width);
    expect(a!.height).toBe(c!.height);
    expect(b!.top).toBe(a!.top);
    expect(c!.top).toBeGreaterThan(a!.bottom);
    const next = Array.from(host.querySelectorAll('*')).find(
      (element) => element.children.length === 0 && element.textContent === 'After gallery'
    )!;
    expect(next.getBoundingClientRect().top).toBeGreaterThanOrEqual(c!.bottom);
  });

  it('opens an inline PDF from the chat and releases the viewer when closed', async () => {
    const uri = 'data:application/pdf;base64,' + btoa('%PDF-1.4\n%%EOF');
    const host = mount([
      {
        kind: 'message',
        role: 'assistant',
        id: 'inline-pdf',
        seq: 0,
        text: '',
        artifacts: [{ uri, name: 'report.pdf' }],
      },
    ]);
    await paint();
    const button = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Önizle'
    )!;
    button.click();
    await waitFor(() => !!host.querySelector('dialog[open] object[type="application/pdf"]'));
    const object = host.querySelector('object')!;
    const bytes = await (await fetch(object.data)).text();
    expect(bytes).toBe('%PDF-1.4\n%%EOF');
    host.querySelector('dialog')!.close();
    await waitFor(() => !host.querySelector('object'));
  });

  it('saves streamable outputs through the host instead of loading them first', async () => {
    const saveArtifact = vi.fn(async () => {});
    const resolveArtifact = vi.fn(async () => ({ url: 'blob:never' }));
    const host = mount(
      [
        {
          kind: 'message',
          id: 'pdf',
          seq: 0,
          role: 'assistant',
          text: '',
          artifacts: [{ uri: '/docs/big.pdf', name: 'big.pdf', mimeType: 'application/pdf' }],
        },
      ],
      { saveArtifact, resolveArtifact }
    );
    await paint();
    const pill = host.querySelector('section[aria-label="Output: big.pdf"]') as HTMLElement;
    expect(pill.textContent).not.toContain('Kaydetmek için yükle');
    const save = Array.from(pill.querySelectorAll('button')).find(
      (button) => button.textContent === 'Kaydet'
    )!;
    save.click();
    expect(saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ uri: '/docs/big.pdf' }));
    expect(resolveArtifact).not.toHaveBeenCalled();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A silent 8 kHz mono PCM WAV of the given length, as a blob URL. */
function silentWavUrl(seconds: number): string {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

async function recordWebm(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  canvas.getContext('2d')?.fillRect(0, 0, 64, 36);
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
  return url;
}
