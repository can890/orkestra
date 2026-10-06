import { err, ok } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import { SpokenRepliesStore, type AudioLike, type SpokenRepliesDeps } from './spoken-replies-store';

class FakeAudio implements AudioLike {
  src = '';
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn(() => {});
}

function setup(overrides: Partial<SpokenRepliesDeps> = {}) {
  const audios: FakeAudio[] = [];
  let urlCounter = 0;
  const deps: SpokenRepliesDeps = {
    synthesize: vi.fn(async () => ok(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }))),
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    createObjectURL: vi.fn(() => `blob:${++urlCounter}`),
    revokeObjectURL: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return { store: new SpokenRepliesStore(deps), deps, audios };
}

describe('SpokenRepliesStore', () => {
  it('varsayılan kapalıdır ve kapalı konuşmada tur okumaz', () => {
    const { store, deps } = setup();
    expect(store.isEnabled('c1')).toBe(false);
    store.speakTurn('c1', 't1', 'Merhaba');
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  it('açıkken temizlenmiş metni üretip oynatır, aynı turu ikinci kez okumaz', async () => {
    const { store, deps, audios } = setup();
    store.toggle('c1');
    store.speakTurn('c1', 't1', '**Bitti.** Kod:\n```\nx\n```');
    await vi.waitFor(() => expect(store.playback?.status).toBe('playing'));
    expect(vi.mocked(deps.synthesize).mock.calls[0][0]).toBe('Bitti. Kod: (kod bloğu atlandı).');
    expect(audios[0].src).toBe('blob:1');
    store.speakTurn('c1', 't1', 'Bitti.');
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });

  it('durdurma oynatmayı keser ve nesne adresini bırakır', async () => {
    const { store, deps, audios } = setup();
    await store.speak('c1', 'Uzun yanıt');
    expect(store.isSpeaking('c1')).toBe(true);
    store.stop();
    expect(audios[0].pause).toHaveBeenCalled();
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(store.playback).toBeNull();
  });

  it('oynatma bittiğinde kaynakları temizler', async () => {
    const { store, deps, audios } = setup();
    await store.speak('c1', 'Kısa');
    audios[0].onended?.(new Event('ended'));
    expect(store.playback).toBeNull();
    expect(deps.revokeObjectURL).toHaveBeenCalled();
  });

  it('anahtarı kapatmak o konuşmanın okumasını durdurur', async () => {
    const { store } = setup();
    store.toggle('c1');
    await store.speak('c1', 'Yanıt');
    expect(store.toggle('c1')).toBe(false);
    expect(store.playback).toBeNull();
  });

  it('üretim hatasını Türkçe mesajla bildirir', async () => {
    const onError = vi.fn();
    const { store } = setup({
      synthesize: vi.fn(async () => err({ type: 'missing_api_key' as const })),
      onError,
    });
    await store.speak('c1', 'Yanıt');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('API anahtarı'), true);
    expect(store.playback).toBeNull();
  });

  it('yeni okuma bekleyen eskisini geçersiz kılar', async () => {
    const pending: { resolveFirst?: () => void } = {};
    const synthesize = vi
      .fn<SpokenRepliesDeps['synthesize']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pending.resolveFirst = () => resolve(ok(new Blob(['a'])));
          })
      )
      .mockImplementation(async () => ok(new Blob(['b'])));
    const { store, audios } = setup({ synthesize });
    const first = store.speak('c1', 'Birinci');
    await store.speak('c2', 'İkinci');
    pending.resolveFirst?.();
    await first;
    expect(audios).toHaveLength(1);
    expect(store.playback?.conversationId).toBe('c2');
  });

  it('markTurnSeen sonrası aynı tur okunmaz', () => {
    const { store, deps } = setup();
    store.toggle('c1');
    store.markTurnSeen('c1', 't9');
    store.speakTurn('c1', 't9', 'Eski yanıt');
    expect(deps.synthesize).not.toHaveBeenCalled();
  });
});
