import type { Result } from '@orkestra/shared';
import { action, makeObservable, observable } from 'mobx';
import { MAX_SPEECH_CHARACTERS, type VoiceError } from '@core/features/voice/api/contract';
import { markdownToSpeechText } from '@core/features/voice/api/speech-text';
import { voiceErrorMessage, voiceErrorNeedsSettings } from '@core/features/voice/api/voice-errors';

// Konuşma başına "sesli yanıt" anahtarını ve tek seferde tek bir oynatmayı yöneten uygulama
// ömürlü depo. Varsayılan kapalıdır; anahtar uygulama oturumu boyunca bellekte tutulur.

export type AudioLike = {
  src: string;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
  play(): Promise<void>;
  pause(): void;
};

export type SpokenRepliesDeps = {
  synthesize(text: string, signal: AbortSignal): Promise<Result<Blob, VoiceError>>;
  createAudio(): AudioLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  onError(message: string, needsSettings: boolean): void;
};

export type SpokenPlayback = {
  conversationId: string;
  status: 'loading' | 'playing';
};

export class SpokenRepliesStore {
  private readonly enabled = observable.set<string>();
  playback: SpokenPlayback | null = null;
  private audio: AudioLike | null = null;
  private objectUrl: string | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  /** Aynı turu iki kez okumamak için konuşma başına son okunan tur kimliği. */
  private readonly spokenTurns = new Map<string, string>();

  constructor(private readonly deps: SpokenRepliesDeps) {
    makeObservable<SpokenRepliesStore, 'setPlayback'>(this, {
      playback: observable.ref,
      toggle: action,
      setPlayback: action,
    });
  }

  isEnabled(conversationId: string): boolean {
    return this.enabled.has(conversationId);
  }

  isSpeaking(conversationId: string): boolean {
    return this.playback?.conversationId === conversationId;
  }

  toggle(conversationId: string): boolean {
    if (this.enabled.has(conversationId)) {
      this.enabled.delete(conversationId);
      if (this.isSpeaking(conversationId)) this.stop();
      return false;
    }
    this.enabled.add(conversationId);
    return true;
  }

  /** Tur tamamlandığında çağrılır; konuşma için anahtar açıksa yanıtı okur. */
  speakTurn(conversationId: string, turnId: string, markdown: string): void {
    if (!this.isEnabled(conversationId)) return;
    if (this.spokenTurns.get(conversationId) === turnId) return;
    this.spokenTurns.set(conversationId, turnId);
    void this.speak(conversationId, markdown);
  }

  /** Tur kimliğini okunmuş say (anahtar açılmadan önce biten yanıtlar okunmasın). */
  markTurnSeen(conversationId: string, turnId: string): void {
    this.spokenTurns.set(conversationId, turnId);
  }

  async speak(conversationId: string, markdown: string): Promise<void> {
    const text = markdownToSpeechText(markdown, { maxChars: MAX_SPEECH_CHARACTERS });
    if (!text) return;
    this.stop();
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.setPlayback({ conversationId, status: 'loading' });

    const result = await this.deps.synthesize(text, abort.signal);
    if (generation !== this.generation) return;
    if (!result.success) {
      this.setPlayback(null);
      this.abort = null;
      this.deps.onError(voiceErrorMessage(result.error), voiceErrorNeedsSettings(result.error));
      return;
    }

    const url = this.deps.createObjectURL(result.data);
    const audio = this.deps.createAudio();
    this.objectUrl = url;
    this.audio = audio;
    audio.onended = () => {
      if (generation === this.generation) this.stop();
    };
    audio.onerror = () => {
      if (generation !== this.generation) return;
      this.stop();
      this.deps.onError('Ses oynatılamadı.', false);
    };
    audio.src = url;
    try {
      await audio.play();
      if (generation === this.generation) this.setPlayback({ conversationId, status: 'playing' });
    } catch {
      if (generation !== this.generation) return;
      this.stop();
      this.deps.onError('Ses oynatılamadı.', false);
    }
  }

  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.objectUrl) {
      this.deps.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.setPlayback(null);
  }

  dispose(): void {
    this.stop();
  }

  private setPlayback(playback: SpokenPlayback | null): void {
    this.playback = playback;
  }
}
