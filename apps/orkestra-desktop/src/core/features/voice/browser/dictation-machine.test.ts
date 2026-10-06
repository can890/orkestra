import { describe, expect, it } from 'vitest';
import {
  dictationLabel,
  dictationReducer,
  formatElapsed,
  initialDictationState,
  isDictationShortcut,
  normalizeTranscript,
  toggleEvent,
  transcriptInsertion,
  type DictationEvent,
  type DictationState,
} from './dictation-machine';

function run(events: DictationEvent[], from: DictationState = initialDictationState) {
  return events.reduce(dictationReducer, from);
}

describe('dictationReducer', () => {
  it('başarılı oturum: boşta → izin → kayıt → yazıya dökme → boşta', () => {
    let state = run([{ type: 'start' }]);
    expect(state).toEqual({ kind: 'requesting' });
    state = dictationReducer(state, { type: 'recording-started', at: 1000 });
    expect(state).toEqual({ kind: 'recording', startedAt: 1000 });
    state = dictationReducer(state, { type: 'stop' });
    expect(state).toEqual({ kind: 'transcribing' });
    state = dictationReducer(state, { type: 'transcribed' });
    expect(state).toEqual({ kind: 'idle' });
  });

  it('hata durumuna geçer; yeni başlangıç ya da kapatma hatayı temizler', () => {
    const failed = run([
      { type: 'start' },
      { type: 'failed', message: 'Anahtar yok', needsSettings: true },
    ]);
    expect(failed).toEqual({ kind: 'error', message: 'Anahtar yok', needsSettings: true });
    expect(dictationReducer(failed, { type: 'start' })).toEqual({ kind: 'requesting' });
    expect(dictationReducer(failed, { type: 'dismiss' })).toEqual({ kind: 'idle' });
  });

  it('iptal edilen oturumdan gelen geç olaylar durumu değiştirmez', () => {
    const cancelled = run([
      { type: 'start' },
      { type: 'recording-started', at: 1 },
      { type: 'cancel' },
    ]);
    expect(cancelled).toEqual({ kind: 'idle' });
    expect(dictationReducer(cancelled, { type: 'failed', message: 'geç' })).toBe(cancelled);
    expect(dictationReducer(cancelled, { type: 'transcribed' })).toBe(cancelled);
    expect(dictationReducer(cancelled, { type: 'recording-started', at: 2 })).toBe(cancelled);
  });

  it('geçersiz geçişleri yok sayar', () => {
    const transcribing: DictationState = { kind: 'transcribing' };
    expect(dictationReducer(transcribing, { type: 'start' })).toBe(transcribing);
    expect(dictationReducer(transcribing, { type: 'cancel' })).toBe(transcribing);
    expect(dictationReducer(initialDictationState, { type: 'stop' })).toBe(initialDictationState);
  });
});

describe('toggleEvent', () => {
  it('düğme her durumda doğru olayı üretir', () => {
    expect(toggleEvent({ kind: 'idle' })).toEqual({ type: 'start' });
    expect(toggleEvent({ kind: 'error', message: 'x', needsSettings: false })).toEqual({
      type: 'start',
    });
    expect(toggleEvent({ kind: 'requesting' })).toEqual({ type: 'cancel' });
    expect(toggleEvent({ kind: 'recording', startedAt: 0 })).toEqual({ type: 'stop' });
    expect(toggleEvent({ kind: 'transcribing' })).toBeNull();
  });

  it('Türkçe etiketler üretir', () => {
    expect(dictationLabel({ kind: 'idle' })).toBe('Sesle yaz');
    expect(dictationLabel({ kind: 'error', message: 'Mikrofon yok', needsSettings: false })).toBe(
      'Mikrofon yok'
    );
  });
});

describe('yardımcılar', () => {
  it('süreyi d:ss biçiminde verir', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('transkripti tek satıra indirir ve HTML benzeri dizileri bozar', () => {
    expect(normalizeTranscript('  merhaba\n dünya  ')).toBe('merhaba dünya');
    expect(normalizeTranscript('a <div> b < c')).toBe('a < div> b < c');
  });

  it('imleç önündeki metne göre başa boşluk ekler', () => {
    expect(transcriptInsertion('', 'merhaba')).toBe('merhaba');
    expect(transcriptInsertion('şunu yap', 'merhaba')).toBe(' merhaba');
    expect(transcriptInsertion('şunu yap ', 'merhaba')).toBe('merhaba');
    expect(transcriptInsertion('x', '   ')).toBe('');
  });

  it('Mod+Shift+Space kısayolunu platforma göre tanır', () => {
    const base = { code: 'Space', key: ' ', shiftKey: true, altKey: false };
    expect(isDictationShortcut({ ...base, metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isDictationShortcut({ ...base, metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isDictationShortcut({ ...base, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(
      isDictationShortcut({ ...base, shiftKey: false, metaKey: true, ctrlKey: false }, true)
    ).toBe(false);
  });
});
