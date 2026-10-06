// Mikrofon düğmesinin durum makinesi. Saf bir reducer'dır; MediaRecorder ve ağ çağrıları
// use-dictation.ts içinde bu olaylara çevrilir.

export type DictationState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string; needsSettings: boolean };

export type DictationEvent =
  | { type: 'start' }
  | { type: 'recording-started'; at: number }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'transcribed' }
  | { type: 'failed'; message: string; needsSettings?: boolean }
  | { type: 'dismiss' };

export const initialDictationState: DictationState = { kind: 'idle' };

export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case 'start':
      return state.kind === 'idle' || state.kind === 'error' ? { kind: 'requesting' } : state;
    case 'recording-started':
      return state.kind === 'requesting' ? { kind: 'recording', startedAt: event.at } : state;
    case 'stop':
      return state.kind === 'recording' ? { kind: 'transcribing' } : state;
    case 'cancel':
      return state.kind === 'requesting' || state.kind === 'recording' ? { kind: 'idle' } : state;
    case 'transcribed':
      return state.kind === 'transcribing' ? { kind: 'idle' } : state;
    case 'failed':
      // İptal edilmiş (idle) bir oturumdan gelen geç hatalar yok sayılır.
      return state.kind === 'idle'
        ? state
        : { kind: 'error', message: event.message, needsSettings: event.needsSettings ?? false };
    case 'dismiss':
      return state.kind === 'error' ? { kind: 'idle' } : state;
  }
}

/** Tek düğme/kısayol etkileşiminin hangi olaya dönüştüğü; null ise etkileşim yok sayılır. */
export function toggleEvent(state: DictationState): DictationEvent | null {
  switch (state.kind) {
    case 'idle':
    case 'error':
      return { type: 'start' };
    case 'recording':
      return { type: 'stop' };
    case 'requesting':
      return { type: 'cancel' };
    case 'transcribing':
      return null;
  }
}

export function dictationLabel(state: DictationState): string {
  switch (state.kind) {
    case 'idle':
      return 'Sesle yaz';
    case 'requesting':
      return 'Mikrofon hazırlanıyor…';
    case 'recording':
      return 'Kaydı durdur ve yazıya dök';
    case 'transcribing':
      return 'Yazıya dökülüyor…';
    case 'error':
      return state.message;
  }
}

/** Kayıt süresini "d:ss" biçiminde verir. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Yazıya dökülen metni editöre güvenle eklenebilir hâle getirir: satır sonları boşluğa
 * dönüşür ve editörün HTML ayrıştırıcısının etiket sanabileceği "<harf" dizileri bozulur.
 */
export function normalizeTranscript(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/<(?=[A-Za-z/!?])/g, '< ')
    .trim();
}

/** İmleç önündeki metne göre eklenecek metnin başına boşluk gerekip gerekmediği. */
export function transcriptInsertion(textBeforeCursor: string, transcript: string): string {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return '';
  const needsLeadingSpace = textBeforeCursor.length > 0 && !/\s$/.test(textBeforeCursor);
  return needsLeadingSpace ? ` ${normalized}` : normalized;
}

/** Mod+Shift+Space (macOS'ta ⌘, diğerlerinde Ctrl). */
export function isDictationShortcut(
  event: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && event.shiftKey && !event.altKey && (event.code === 'Space' || event.key === ' ');
}
