import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getVoiceClient } from '@core/features/voice/api/browser/client';
import {
  microphoneAccessMessage,
  voiceErrorMessage,
  voiceErrorNeedsSettings,
} from '@core/features/voice/api/voice-errors';
import {
  dictationReducer,
  initialDictationState,
  toggleEvent,
  type DictationState,
} from './dictation-machine';

// Dikte oturumunu yönetir: mikrofon izni → MediaRecorder kaydı → ana sürece yükleme →
// ElevenLabs Scribe ile yazıya dökme. Ses verisi renderer'dan yalnızca Wire dosya kanalıyla
// ana sürece gider; API anahtarı renderer'a hiç gelmez.

/** Kayıt bu süreyi aşarsa kendiliğinden durdurulup yazıya dökülür. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Bundan kısa kayıtlar gönderilmez (yanlışlıkla tıklama). */
const MIN_RECORDING_MS = 400;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

type Session = {
  id: number;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  startedAt: number;
  cancelled: boolean;
  abort: AbortController;
  maxTimer: ReturnType<typeof setTimeout> | null;
};

export type UseDictationOptions = {
  onTranscript: (text: string) => void;
  onError?: (message: string, needsSettings: boolean) => void;
};

export type DictationController = {
  state: DictationState;
  toggle: () => void;
  cancel: () => void;
  dismiss: () => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function useDictation({ onTranscript, onError }: UseDictationOptions): DictationController {
  const [state, dispatch] = useReducer(dictationReducer, initialDictationState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef<Session | null>(null);
  const sessionCounter = useRef(0);
  const callbacksRef = useRef({ onTranscript, onError });
  callbacksRef.current = { onTranscript, onError };

  const fail = useCallback((message: string, needsSettings = false) => {
    dispatch({ type: 'failed', message, needsSettings });
    callbacksRef.current.onError?.(message, needsSettings);
  }, []);

  const releaseSession = useCallback((session: Session) => {
    if (session.maxTimer) clearTimeout(session.maxTimer);
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = null;
    if (sessionRef.current?.id === session.id) sessionRef.current = null;
  }, []);

  const transcribe = useCallback(
    async (session: Session, blob: Blob) => {
      try {
        const client = await getVoiceClient();
        const extension = blob.type.includes('ogg') ? 'ogg' : 'webm';
        const result = await client.transcribe(
          {},
          {
            name: `dikte.${extension}`,
            mimeType: blob.type.split(';')[0] || 'audio/webm',
            size: blob.size,
            source: blob.stream(),
          },
          { signal: session.abort.signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS }
        );
        if (session.cancelled) return;
        if (!result.success) {
          fail(voiceErrorMessage(result.error), voiceErrorNeedsSettings(result.error));
          return;
        }
        if (!result.data.text.trim()) {
          fail('Konuşma algılanamadı. Tekrar deneyin.');
          return;
        }
        callbacksRef.current.onTranscript(result.data.text);
        dispatch({ type: 'transcribed' });
      } catch (error) {
        if (!session.cancelled) {
          fail(`Yazıya dökme başarısız: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    [fail]
  );

  const stopRecording = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.recorder || session.recorder.state === 'inactive') return;
    dispatch({ type: 'stop' });
    session.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    const session: Session = {
      id: ++sessionCounter.current,
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: 0,
      cancelled: false,
      abort: new AbortController(),
      maxTimer: null,
    };
    sessionRef.current = session;
    dispatch({ type: 'start' });

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      fail('Bu ortamda mikrofon kaydı desteklenmiyor.');
      releaseSession(session);
      return;
    }

    try {
      const client = await getVoiceClient();
      const status = await client.getStatus();
      if (session.cancelled) return;
      if (!status.hasApiKey) {
        fail(voiceErrorMessage({ type: 'missing_api_key' }), true);
        releaseSession(session);
        return;
      }
      const access = await client.requestMicrophoneAccess();
      if (session.cancelled) return;
      const accessMessage = microphoneAccessMessage(access);
      if (accessMessage) {
        fail(accessMessage);
        releaseSession(session);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      session.stream = stream;
      if (session.cancelled) {
        releaseSession(session);
        return;
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      session.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        const duration = Date.now() - session.startedAt;
        const blob = new Blob(session.chunks, { type: recorder.mimeType || mimeType });
        releaseSession(session);
        if (session.cancelled) return;
        if (duration < MIN_RECORDING_MS || blob.size === 0) {
          fail('Kayıt çok kısa. Konuşurken kaydı biraz daha açık tutun.');
          return;
        }
        void transcribe(session, blob);
      };
      recorder.onerror = () => {
        releaseSession(session);
        if (!session.cancelled) fail('Mikrofon kaydı beklenmedik biçimde durdu.');
      };
      session.startedAt = Date.now();
      recorder.start(1000);
      session.maxTimer = setTimeout(() => {
        if (sessionRef.current?.id === session.id) stopRecording();
      }, MAX_RECORDING_MS);
      dispatch({ type: 'recording-started', at: session.startedAt });
    } catch (error) {
      releaseSession(session);
      if (session.cancelled) return;
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        fail(microphoneAccessMessage('denied') ?? 'Mikrofon izni verilmedi.');
      } else if (name === 'NotFoundError') {
        fail('Kullanılabilir bir mikrofon bulunamadı.');
      } else {
        fail(`Mikrofon başlatılamadı: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [fail, releaseSession, stopRecording, transcribe]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      session.cancelled = true;
      session.abort.abort();
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
      releaseSession(session);
    }
    dispatch({ type: 'cancel' });
  }, [releaseSession]);

  const toggle = useCallback(() => {
    const event = toggleEvent(stateRef.current);
    if (!event) return;
    if (event.type === 'start') void start();
    else if (event.type === 'stop') stopRecording();
    else if (event.type === 'cancel') cancel();
  }, [cancel, start, stopRecording]);

  const dismiss = useCallback(() => dispatch({ type: 'dismiss' }), []);

  // Bileşen kaldırılırken açık mikrofon akışını kapat ve bekleyen isteği iptal et.
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (!session) return;
      session.cancelled = true;
      session.abort.abort();
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
      releaseSession(session);
    },
    [releaseSession]
  );

  return { state, toggle, cancel, dismiss };
}
