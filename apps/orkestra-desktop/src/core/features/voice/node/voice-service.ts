import { err, ok, secret, type Result } from '@orkestra/shared';
import {
  DEFAULT_OPENAI_STT_BASE_URL,
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_VOICE_PREFERENCES,
  MAX_SPEECH_CHARACTERS,
  VOICE_AUTO_LANGUAGE,
  voicePreferencesSchema,
  type EffectiveSttProvider,
  type LocalSttEngine,
  type LocalSttStatus,
  type MicrophoneAccess,
  type Transcription,
  type VoiceError,
  type VoicePreferences,
  type VoiceStatus,
  type VoiceSummary,
} from '@core/features/voice/api/contract';
import {
  applyCustomWords,
  buildWhisperCustomWordsPrompt,
} from '@core/features/voice/api/custom-words';
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
import type { LocalSttPort } from './local-stt-runner';

// Ana süreçteki ses servisi: ElevenLabs veya OpenAI uyumlu API anahtarlarını şifreli depodan okur,
// yerel STT işçisini (MLX Whisper / faster-whisper) çalıştırır. Hiçbir anahtar renderer'a
// ya da günlüğe sızmaz.

export const ELEVENLABS_API_KEY_SECRET = 'voice.elevenlabs.apiKey';
export const OPENAI_STT_API_KEY_SECRET = 'voice.openaiStt.apiKey';

const DEFAULT_UNAVAILABLE_LOCAL_STT: LocalSttStatus = {
  available: false,
  ffmpegAvailable: false,
  cachedModels: [],
  reason: 'Yerel STT bu bağlamda yapılandırılmadı.',
};

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function normalizeOpenAiSttEndpoint(rawBaseUrl: string): string | null {
  const trimmed = rawBaseUrl.trim() || DEFAULT_OPENAI_STT_BASE_URL;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const clean = parsed.toString().replace(/\/+$/, '');
    return clean.endsWith('/audio/transcriptions') ? clean : `${clean}/audio/transcriptions`;
  } catch {
    return null;
  }
}

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
  localStt?: LocalSttPort;
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

  private async detectLocal(preferences: VoicePreferences): Promise<LocalSttStatus> {
    if (!this.deps.localStt) return DEFAULT_UNAVAILABLE_LOCAL_STT;
    return this.deps.localStt.detect({
      customPythonPath: preferences.localSttPythonPath || undefined,
    });
  }

  private resolveEffectiveProvider(params: {
    preferences: VoicePreferences;
    localAvailable: boolean;
    hasElevenLabsKey: boolean;
    hasOpenAiKey: boolean;
  }): EffectiveSttProvider {
    const { preferences, localAvailable, hasElevenLabsKey, hasOpenAiKey } = params;
    const openAiReady = hasOpenAiKey || isLoopbackUrl(preferences.openAiSttBaseUrl);
    switch (preferences.sttProvider) {
      case 'local':
        return localAvailable ? 'local' : 'none';
      case 'openai-compatible':
        return openAiReady ? 'openai-compatible' : 'none';
      case 'elevenlabs':
        return hasElevenLabsKey ? 'elevenlabs' : 'none';
      case 'auto':
      default:
        if (localAvailable) return 'local';
        if (openAiReady) return 'openai-compatible';
        if (hasElevenLabsKey) return 'elevenlabs';
        return 'none';
    }
  }

  async getStatus(): Promise<VoiceStatus> {
    const preferences = await this.getPreferences();
    const [elevenKey, openAiKey, localStt] = await Promise.all([
      this.readSecretValue(ELEVENLABS_API_KEY_SECRET),
      this.readSecretValue(OPENAI_STT_API_KEY_SECRET),
      this.detectLocal(preferences),
    ]);
    const hasApiKey = elevenKey !== null;
    const hasOpenAiSttApiKey = openAiKey !== null;
    const effectiveSttProvider = this.resolveEffectiveProvider({
      preferences,
      localAvailable: localStt.available,
      hasElevenLabsKey: hasApiKey,
      hasOpenAiKey: hasOpenAiSttApiKey,
    });
    return {
      hasApiKey,
      hasOpenAiSttApiKey,
      localStt,
      effectiveSttProvider,
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      preferences,
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
    return this.storeSecretKey(ELEVENLABS_API_KEY_SECRET, 'elevenlabs', rawKey);
  }

  async clearApiKey(): Promise<Result<void, VoiceError>> {
    return this.removeSecretKey(ELEVENLABS_API_KEY_SECRET);
  }

  async setOpenAiSttApiKey(rawKey: string): Promise<Result<void, VoiceError>> {
    return this.storeSecretKey(OPENAI_STT_API_KEY_SECRET, 'openai-stt', rawKey);
  }

  async clearOpenAiSttApiKey(): Promise<Result<void, VoiceError>> {
    return this.removeSecretKey(OPENAI_STT_API_KEY_SECRET);
  }

  async testLocalStt(): Promise<
    Result<{ engine: LocalSttEngine; model: string; latencyMs: number }, VoiceError>
  > {
    if (!this.deps.localStt) {
      return err({
        type: 'local_stt_unavailable',
        message: 'Yerel STT çalıştırıcısı bu ortamda etkin değil.',
      });
    }
    const preferences = await this.getPreferences();
    return this.deps.localStt.test({
      model: preferences.localSttModel,
      customPythonPath: preferences.localSttPythonPath || undefined,
    });
  }

  private async storeSecretKey(
    secretKey: string,
    label: string,
    rawKey: string
  ): Promise<Result<void, VoiceError>> {
    const apiKey = rawKey.trim();
    if (!API_KEY_PATTERN.test(apiKey)) {
      return err({ type: 'invalid_input', message: 'API anahtarı boşluk içeremez.' });
    }
    if (!this.deps.isSecureStorageAvailable()) {
      return err({ type: 'storage_unavailable', message: 'safeStorage kullanılamıyor.' });
    }
    try {
      await this.deps.secrets.setSecret(secretKey, secret(apiKey, label));
      return ok();
    } catch (error) {
      this.deps.logger?.warn('API anahtarı kaydedilemedi', {
        secretKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return err({ type: 'storage_unavailable', message: 'Anahtar şifreli depoya yazılamadı.' });
    }
  }

  private async removeSecretKey(secretKey: string): Promise<Result<void, VoiceError>> {
    try {
      await this.deps.secrets.deleteSecret(secretKey);
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

    const preferences = await this.getPreferences();
    const language = input.language ?? preferences.sttLanguage;
    const [elevenKey, openAiKey, localStt] = await Promise.all([
      this.readSecretValue(ELEVENLABS_API_KEY_SECRET),
      this.readSecretValue(OPENAI_STT_API_KEY_SECRET),
      preferences.sttProvider === 'auto' || preferences.sttProvider === 'local'
        ? this.detectLocal(preferences)
        : Promise.resolve(DEFAULT_UNAVAILABLE_LOCAL_STT),
    ]);

    const provider = this.resolveEffectiveProvider({
      preferences,
      localAvailable: localStt.available,
      hasElevenLabsKey: elevenKey !== null,
      hasOpenAiKey: openAiKey !== null,
    });

    const postProcess = (t: Transcription): Transcription => ({
      ...t,
      text: applyCustomWords(t.text, preferences.customWords ?? []),
    });

    if (provider === 'local' && this.deps.localStt) {
      const localRes = await this.deps.localStt.transcribe({
        audio: input.audio,
        fileName: input.fileName,
        language,
        model: preferences.localSttModel,
        customPythonPath: preferences.localSttPythonPath || undefined,
        signal,
      });
      return localRes.success ? ok(postProcess(localRes.data)) : localRes;
    }

    if (provider === 'openai-compatible') {
      const endpoint = normalizeOpenAiSttEndpoint(preferences.openAiSttBaseUrl);
      if (!endpoint) {
        return err({ type: 'invalid_input', message: 'Geçersiz OpenAI STT Base URL adresi.' });
      }
      const form = new FormData();
      form.append('file', input.audio, input.fileName);
      form.append('model', preferences.openAiSttModel.trim() || DEFAULT_OPENAI_STT_MODEL);
      const cleanLang = language.trim().toLowerCase();
      if (cleanLang && cleanLang !== VOICE_AUTO_LANGUAGE) {
        form.append('language', cleanLang.slice(0, 2));
      }
      const promptHint = buildWhisperCustomWordsPrompt(preferences.customWords ?? []);
      if (promptHint) {
        form.append('prompt', promptHint);
      }
      const headers: Record<string, string> = {};
      if (openAiKey) {
        headers.Authorization = `Bearer ${openAiKey}`;
      }
      const response = await this.send(
        {
          url: endpoint,
          init: { method: 'POST', headers, body: form },
        },
        signal
      );
      if (!response.success) return response;
      const transcription = parseTranscription(await response.data.json().catch(() => null));
      if (!transcription) {
        return err({ type: 'http', status: response.data.status, message: 'Beklenmeyen yanıt.' });
      }
      return ok(postProcess(transcription));
    }

    if (provider === 'elevenlabs' && elevenKey) {
      const response = await this.send(
        buildTranscriptionRequest({
          apiKey: elevenKey,
          audio: input.audio,
          fileName: input.fileName,
          language,
        }),
        signal
      );
      if (!response.success) return response;
      const transcription = parseTranscription(await response.data.json().catch(() => null));
      if (!transcription) {
        return err({ type: 'http', status: response.data.status, message: 'Beklenmeyen yanıt.' });
      }
      return ok(postProcess(transcription));
    }

    if (preferences.sttProvider === 'local') {
      return err({
        type: 'local_stt_unavailable',
        message: localStt.reason ?? 'Yerel Whisper motoru bulunamadı.',
      });
    }
    return err({ type: 'missing_api_key' });
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
    return this.readSecretValue(ELEVENLABS_API_KEY_SECRET);
  }

  private async readSecretValue(secretKey: string): Promise<string | null> {
    try {
      const stored = await this.deps.secrets.getSecret(secretKey);
      const value = stored?.expose().trim();
      return value ? value : null;
    } catch (error) {
      this.deps.logger?.warn('API anahtarı okunamadı', {
        secretKey,
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
