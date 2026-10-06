import { err, ok, secret, type Result } from '@orkestra/shared';
import {
  DEFAULT_VOICE_PREFERENCES,
  MAX_SPEECH_CHARACTERS,
  voicePreferencesSchema,
  type MicrophoneAccess,
  type Transcription,
  type VoiceError,
  type VoicePreferences,
  type VoiceStatus,
  type VoiceSummary,
} from '@core/features/voice/api/contract';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  buildListVoicesRequest,
  buildSpeechRequest,
  buildTranscriptionRequest,
  ELEVENLABS_VOICES_MAX_PAGES,
  mapHttpError,
  parseTranscription,
  parseVoicesPage,
  type HttpRequest,
} from './elevenlabs-requests';

// Ana süreçteki ses servisi: ElevenLabs anahtarını şifreli depodan okur, ağ çağrılarını
// enjekte edilen fetch ile yapar. Anahtar hiçbir dönüş değerine, hata mesajına ya da
// günlük kaydına girmez.

export const ELEVENLABS_API_KEY_SECRET = 'voice.elevenlabs.apiKey';

export type VoiceFetch = (
  url: string,
  init: HttpRequest['init'] & { signal?: AbortSignal }
) => Promise<Response>;

export type VoicePreferencesStore = {
  get(): Promise<Partial<VoicePreferences> | null>;
  set(preferences: VoicePreferences): Promise<void>;
};

export type MicrophonePermissions = {
  getAccess(): MicrophoneAccess;
  requestAccess(): Promise<MicrophoneAccess>;
  openSettings(): Promise<void>;
};

type VoiceLogger = {
  warn(message: string, context?: Record<string, unknown>): void;
};

export type VoiceServiceDeps = {
  secrets: SecretStore;
  preferences: VoicePreferencesStore;
  fetch: VoiceFetch;
  isSecureStorageAvailable: () => boolean;
  microphone: MicrophonePermissions;
  logger?: VoiceLogger;
  /** Tek bir ağ isteği için üst süre (ms). */
  requestTimeoutMs?: number;
};

export type SynthesizedSpeech = { bytes: Uint8Array; mimeType: string };

const DEFAULT_TIMEOUT_MS = 90_000;
/** API anahtarlarında boşluk ve kontrol karakteri olamaz. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  async getStatus(): Promise<VoiceStatus> {
    return {
      hasApiKey: (await this.readApiKey()) !== null,
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      preferences: await this.getPreferences(),
    };
  }

  async getPreferences(): Promise<VoicePreferences> {
    const stored = await this.deps.preferences.get().catch(() => null);
    const parsed = voicePreferencesSchema.safeParse({ ...DEFAULT_VOICE_PREFERENCES, ...stored });
    return parsed.success ? parsed.data : DEFAULT_VOICE_PREFERENCES;
  }

  async setPreferences(
    patch: Partial<VoicePreferences>
  ): Promise<Result<VoicePreferences, VoiceError>> {
    const next = voicePreferencesSchema.safeParse({ ...(await this.getPreferences()), ...patch });
    if (!next.success) return err({ type: 'invalid_input', message: 'Geçersiz ses tercihi.' });
    await this.deps.preferences.set(next.data);
    return ok(next.data);
  }

  async setApiKey(rawKey: string): Promise<Result<void, VoiceError>> {
    const apiKey = rawKey.trim();
    if (!API_KEY_PATTERN.test(apiKey)) {
      return err({ type: 'invalid_input', message: 'API anahtarı boşluk içeremez.' });
    }
    if (!this.deps.isSecureStorageAvailable()) {
      return err({ type: 'storage_unavailable', message: 'safeStorage kullanılamıyor.' });
    }
    try {
      await this.deps.secrets.setSecret(ELEVENLABS_API_KEY_SECRET, secret(apiKey, 'elevenlabs'));
      return ok();
    } catch (error) {
      this.deps.logger?.warn('ElevenLabs API anahtarı kaydedilemedi', {
        error: error instanceof Error ? error.message : String(error),
      });
      return err({ type: 'storage_unavailable', message: 'Anahtar şifreli depoya yazılamadı.' });
    }
  }

  async clearApiKey(): Promise<Result<void, VoiceError>> {
    try {
      await this.deps.secrets.deleteSecret(ELEVENLABS_API_KEY_SECRET);
      return ok();
    } catch {
      return err({ type: 'storage_unavailable', message: 'Anahtar silinemedi.' });
    }
  }

  async listVoices(signal?: AbortSignal): Promise<Result<VoiceSummary[], VoiceError>> {
    const apiKey = await this.readApiKey();
    if (!apiKey) return err({ type: 'missing_api_key' });
    const voices: VoiceSummary[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < ELEVENLABS_VOICES_MAX_PAGES; page++) {
      const response = await this.send(buildListVoicesRequest({ apiKey, nextPageToken }), signal);
      if (!response.success) return response;
      const parsed = parseVoicesPage(await response.data.json().catch(() => null));
      if (!parsed) return err({ type: 'http', status: 200, message: 'Beklenmeyen ses listesi.' });
      voices.push(...parsed.voices);
      nextPageToken = parsed.nextPageToken;
      if (!nextPageToken) break;
    }
    return ok(voices);
  }

  async testConnection(signal?: AbortSignal): Promise<Result<{ voiceCount: number }, VoiceError>> {
    const voices = await this.listVoices(signal);
    return voices.success ? ok({ voiceCount: voices.data.length }) : voices;
  }

  async transcribe(
    input: { audio: Blob; fileName: string; mimeType: string; language?: string },
    signal?: AbortSignal
  ): Promise<Result<Transcription, VoiceError>> {
    if (!input.mimeType.startsWith('audio/') && !input.mimeType.startsWith('video/')) {
      return err({ type: 'invalid_input', message: 'Yalnızca ses kaydı yazıya dökülebilir.' });
    }
    if (input.audio.size === 0) {
      return err({ type: 'invalid_input', message: 'Ses kaydı boş.' });
    }
    const apiKey = await this.readApiKey();
    if (!apiKey) return err({ type: 'missing_api_key' });
    const language = input.language ?? (await this.getPreferences()).sttLanguage;
    const response = await this.send(
      buildTranscriptionRequest({ apiKey, audio: input.audio, fileName: input.fileName, language }),
      signal
    );
    if (!response.success) return response;
    const transcription = parseTranscription(await response.data.json().catch(() => null));
    if (!transcription) {
      return err({ type: 'http', status: response.data.status, message: 'Beklenmeyen yanıt.' });
    }
    return ok(transcription);
  }

  async synthesize(
    input: { text: string; voiceId?: string },
    signal?: AbortSignal
  ): Promise<Result<SynthesizedSpeech, VoiceError>> {
    const text = input.text.trim().slice(0, MAX_SPEECH_CHARACTERS);
    if (!text) return err({ type: 'invalid_input', message: 'Okunacak metin boş.' });
    const apiKey = await this.readApiKey();
    if (!apiKey) return err({ type: 'missing_api_key' });
    const preferences = await this.getPreferences();
    const response = await this.send(
      buildSpeechRequest({
        apiKey,
        text,
        voiceId: input.voiceId ?? preferences.ttsVoiceId,
        modelId: preferences.ttsModelId,
        languageCode:
          preferences.sttLanguage === 'auto' ? undefined : preferences.sttLanguage.slice(0, 2),
      }),
      signal
    );
    if (!response.success) return response;
    const bytes = new Uint8Array(await response.data.arrayBuffer());
    const mimeType = response.data.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
    return ok({ bytes, mimeType });
  }

  getMicrophoneAccess(): MicrophoneAccess {
    return this.deps.microphone.getAccess();
  }

  requestMicrophoneAccess(): Promise<MicrophoneAccess> {
    return this.deps.microphone.requestAccess();
  }

  openMicrophoneSettings(): Promise<void> {
    return this.deps.microphone.openSettings();
  }

  /** Anahtarı yalnızca istek kurmak için açar; çağıran asla saklamaz. */
  private async readApiKey(): Promise<string | null> {
    try {
      const stored = await this.deps.secrets.getSecret(ELEVENLABS_API_KEY_SECRET);
      const value = stored?.expose().trim();
      return value ? value : null;
    } catch (error) {
      this.deps.logger?.warn('ElevenLabs API anahtarı okunamadı', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async send(
    request: HttpRequest,
    signal?: AbortSignal
  ): Promise<Result<Response, VoiceError>> {
    const timeout = AbortSignal.timeout(this.deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const path = new URL(request.url).pathname;
    let response: Response;
    try {
      response = await this.deps.fetch(request.url, { ...request.init, signal: combined });
    } catch (error) {
      const message =
        timeout.aborted && !signal?.aborted
          ? 'İstek zaman aşımına uğradı.'
          : error instanceof Error
            ? error.message
            : String(error);
      // Günlüğe istek başlıkları değil, yalnızca adres yolu ve mesaj yazılır.
      this.deps.logger?.warn('ElevenLabs isteği başarısız', { path, message });
      return err({ type: 'network', message });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const mapped = mapHttpError(response.status, body);
      this.deps.logger?.warn('ElevenLabs isteği hata döndü', {
        path,
        status: response.status,
        type: mapped.type,
      });
      return err(mapped);
    }
    return ok(response);
  }
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  return new VoiceService(deps);
}
