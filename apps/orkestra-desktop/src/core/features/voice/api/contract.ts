import { defineContract, downloadFile, fallible, procedure, uploadFile } from '@orkestra/wire/rpc';
import { z } from 'zod';

// Sesli komut (dikte) ve sesli yanıt alanının Wire sözleşmesi. API anahtarı yalnızca ana
// süreçte, şifreli uygulama sırları deposunda yaşar; bu sözleşmenin hiçbir çıktısı anahtarı
// (ya da bir parçasını) taşımaz.

export const voiceDomain = 'voice' as const;

/** STT dil seçeneği: ISO-639-1/3 kodu ya da otomatik algılama. */
export const VOICE_AUTO_LANGUAGE = 'auto' as const;

/** ElevenLabs'ın hazır (premade) çok dilli sesi "George"; Türkçe dahil çok dilli modellerle çalışır. */
export const DEFAULT_TTS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_TTS_VOICE_NAME = 'George';

export const ttsModelIdSchema = z.enum(['eleven_multilingual_v2', 'eleven_flash_v2_5']);
export type TtsModelId = z.infer<typeof ttsModelIdSchema>;

export const voicePreferencesSchema = z.object({
  /** STT dili: 'tr', 'en' … ya da 'auto'. */
  sttLanguage: z
    .string()
    .trim()
    .min(1)
    .max(8)
    .regex(/^[a-z]{2,3}$|^auto$/),
  ttsVoiceId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  ttsVoiceName: z.string().max(200).optional(),
  ttsModelId: ttsModelIdSchema,
});
export type VoicePreferences = z.infer<typeof voicePreferencesSchema>;

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  sttLanguage: 'tr',
  ttsVoiceId: DEFAULT_TTS_VOICE_ID,
  ttsVoiceName: DEFAULT_TTS_VOICE_NAME,
  ttsModelId: 'eleven_multilingual_v2',
};

export const voiceStatusSchema = z.object({
  /** Şifreli depoda bir ElevenLabs anahtarı kayıtlı mı? Anahtarın kendisi asla dönmez. */
  hasApiKey: z.boolean(),
  /** Güvenli depolama (safeStorage) bu sistemde kullanılabilir mi? */
  secureStorageAvailable: z.boolean(),
  preferences: voicePreferencesSchema,
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const voiceErrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('missing_api_key') }),
  z.object({ type: z.literal('invalid_api_key'), message: z.string() }),
  z.object({ type: z.literal('quota_exceeded'), message: z.string() }),
  z.object({ type: z.literal('rate_limited'), message: z.string() }),
  z.object({ type: z.literal('invalid_input'), message: z.string() }),
  z.object({ type: z.literal('network'), message: z.string() }),
  z.object({ type: z.literal('http'), status: z.number().int(), message: z.string() }),
  z.object({ type: z.literal('storage_unavailable'), message: z.string() }),
]);
export type VoiceError = z.infer<typeof voiceErrorSchema>;

export const voiceSummarySchema = z.object({
  voiceId: z.string(),
  name: z.string(),
  category: z.string().optional(),
  /** Etiketlerden türetilmiş kısa açıklama (ör. "male · british"). */
  description: z.string().optional(),
  previewUrl: z.string().optional(),
});
export type VoiceSummary = z.infer<typeof voiceSummarySchema>;

export const transcriptionSchema = z.object({
  text: z.string(),
  languageCode: z.string().optional(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

export const microphoneAccessSchema = z.enum([
  'granted',
  'denied',
  'restricted',
  'not-determined',
  'unknown',
]);
export type MicrophoneAccess = z.infer<typeof microphoneAccessSchema>;

/** Kayıtların üst sınırı: 5 dk opus kaydı birkaç MB'dir; 25 MB bolca pay bırakır. */
export const MAX_DICTATION_AUDIO_BYTES = 25 * 1024 * 1024;
/** Tek bir sesli yanıt için okunacak en fazla karakter (maliyet ve süre sınırı). */
export const MAX_SPEECH_CHARACTERS = 2500;

export const voiceContract = defineContract({
  getStatus: procedure({ input: z.void(), output: voiceStatusSchema }),
  setApiKey: fallible({
    input: z.object({ apiKey: z.string().min(1).max(512) }),
    error: voiceErrorSchema,
  }),
  clearApiKey: fallible({ input: z.void(), error: voiceErrorSchema }),
  setPreferences: fallible({
    input: voicePreferencesSchema.partial(),
    data: voicePreferencesSchema,
    error: voiceErrorSchema,
  }),
  listVoices: fallible({
    input: z.void(),
    data: z.array(voiceSummarySchema),
    error: voiceErrorSchema,
  }),
  /** Kayıtlı anahtarı ElevenLabs'a karşı doğrular (ses listesini çeker). */
  testConnection: fallible({
    input: z.void(),
    data: z.object({ voiceCount: z.number().int() }),
    error: voiceErrorSchema,
  }),
  transcribe: uploadFile({
    input: z.object({ language: z.string().max(8).optional() }),
    maxSize: MAX_DICTATION_AUDIO_BYTES,
    result: transcriptionSchema,
    error: voiceErrorSchema,
  }),
  synthesize: downloadFile({
    input: z.object({
      text: z.string().min(1).max(MAX_SPEECH_CHARACTERS),
      voiceId: voicePreferencesSchema.shape.ttsVoiceId.optional(),
    }),
    error: voiceErrorSchema,
  }),
  getMicrophoneAccess: procedure({ input: z.void(), output: microphoneAccessSchema }),
  /** macOS'ta henüz sorulmadıysa sistem iznini ister; diğer platformlarda durumu döner. */
  requestMicrophoneAccess: procedure({ input: z.void(), output: microphoneAccessSchema }),
  openMicrophoneSettings: procedure({ input: z.void(), output: z.void() }),
});

export type VoiceContract = typeof voiceContract;
