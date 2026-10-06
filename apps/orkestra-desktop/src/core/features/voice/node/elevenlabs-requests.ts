import {
  VOICE_AUTO_LANGUAGE,
  type TtsModelId,
  type Transcription,
  type VoiceError,
  type VoiceSummary,
} from '@core/features/voice/api/contract';

// ElevenLabs REST isteklerinin saf (yan etkisiz) kurucuları ve yanıt çözümleyicileri.
// Ağ çağrısı yapan servis bunları kullanır; testler doğrudan bu dosyayı sınar.

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
/** Güncel Scribe modeli (https://elevenlabs.io/docs/api-reference/speech-to-text/convert). */
export const ELEVENLABS_STT_MODEL = 'scribe_v2';
export const ELEVENLABS_TTS_OUTPUT_FORMAT = 'mp3_44100_128';
export const ELEVENLABS_VOICES_PAGE_SIZE = 100;
/** Ses listesinde çekilecek en fazla sayfa (100 × 5 = 500 ses). */
export const ELEVENLABS_VOICES_MAX_PAGES = 5;

export type HttpRequest = {
  url: string;
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: FormData | string;
  };
};

function authHeaders(apiKey: string): Record<string, string> {
  return { 'xi-api-key': apiKey };
}

export function buildTranscriptionRequest(input: {
  apiKey: string;
  audio: Blob;
  fileName: string;
  /** ISO dil kodu; 'auto' ya da boş değer otomatik algılama demektir. */
  language?: string;
}): HttpRequest {
  const form = new FormData();
  form.append('model_id', ELEVENLABS_STT_MODEL);
  form.append('file', input.audio, input.fileName);
  form.append('tag_audio_events', 'false');
  const language = input.language?.trim().toLowerCase();
  if (language && language !== VOICE_AUTO_LANGUAGE) form.append('language_code', language);
  return {
    url: `${ELEVENLABS_API_BASE}/v1/speech-to-text`,
    init: { method: 'POST', headers: authHeaders(input.apiKey), body: form },
  };
}

export function buildSpeechRequest(input: {
  apiKey: string;
  text: string;
  voiceId: string;
  modelId: TtsModelId;
  languageCode?: string;
}): HttpRequest {
  const url = new URL(
    `${ELEVENLABS_API_BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`
  );
  url.searchParams.set('output_format', ELEVENLABS_TTS_OUTPUT_FORMAT);
  const body: Record<string, string> = { text: input.text, model_id: input.modelId };
  // language_code yalnızca flash/turbo v2.5 modellerinde desteklenir.
  if (input.languageCode && input.modelId === 'eleven_flash_v2_5') {
    body.language_code = input.languageCode;
  }
  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers: {
        ...authHeaders(input.apiKey),
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
    },
  };
}

export function buildListVoicesRequest(input: {
  apiKey: string;
  nextPageToken?: string;
}): HttpRequest {
  const url = new URL(`${ELEVENLABS_API_BASE}/v2/voices`);
  url.searchParams.set('page_size', String(ELEVENLABS_VOICES_PAGE_SIZE));
  if (input.nextPageToken) url.searchParams.set('next_page_token', input.nextPageToken);
  return { url: url.toString(), init: { method: 'GET', headers: authHeaders(input.apiKey) } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseTranscription(json: unknown): Transcription | null {
  const record = asRecord(json);
  if (!record) return null;
  if (typeof record.text === 'string') {
    return { text: record.text.trim(), languageCode: asString(record.language_code) };
  }
  // Çok kanallı yanıt: kanalların metinlerini sırayla birleştir.
  if (Array.isArray(record.transcripts)) {
    const parts = record.transcripts
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const text = parts
      .map((entry) => (typeof entry.text === 'string' ? entry.text.trim() : ''))
      .filter(Boolean)
      .join(' ');
    return { text, languageCode: asString(parts[0]?.language_code) };
  }
  return null;
}

export type VoicesPage = { voices: VoiceSummary[]; nextPageToken?: string };

export function parseVoicesPage(json: unknown): VoicesPage | null {
  const record = asRecord(json);
  if (!record || !Array.isArray(record.voices)) return null;
  const voices: VoiceSummary[] = [];
  for (const entry of record.voices) {
    const voice = asRecord(entry);
    const voiceId = asString(voice?.voice_id);
    const name = asString(voice?.name);
    if (!voice || !voiceId || !name) continue;
    const labels = asRecord(voice.labels);
    const description = labels
      ? Object.values(labels)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' · ') || undefined
      : undefined;
    voices.push({
      voiceId,
      name,
      category: asString(voice.category),
      description,
      previewUrl: asString(voice.preview_url),
    });
  }
  const nextPageToken = record.has_more === true ? asString(record.next_page_token) : undefined;
  return { voices, nextPageToken };
}

/** ElevenLabs hata gövdesinden okunabilir mesajı ve (varsa) durum kodunu çıkarır. */
export function parseErrorDetail(body: string): { status?: string; message: string } {
  try {
    const record = asRecord(JSON.parse(body));
    const detail = record?.detail;
    if (typeof detail === 'string') return { message: detail };
    const detailRecord = asRecord(detail);
    if (detailRecord) {
      return {
        status: asString(detailRecord.status) ?? asString(detailRecord.code),
        message: asString(detailRecord.message) ?? 'Bilinmeyen hata',
      };
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => asString(asRecord(item)?.msg))
        .filter((value): value is string => value !== undefined);
      if (messages.length > 0) return { message: messages.join('; ') };
    }
  } catch {
    // Gövde JSON değil; aşağıda kısaltılmış düz metin döner.
  }
  return { message: body.slice(0, 300) || 'Bilinmeyen hata' };
}

export function mapHttpError(status: number, body: string): VoiceError {
  const detail = parseErrorDetail(body);
  const code = detail.status?.toLowerCase() ?? '';
  // ElevenLabs kota aşımını 401 ile döndürebildiği için önce durum kodu denetlenir.
  if (code.includes('quota') || status === 402) {
    return { type: 'quota_exceeded', message: detail.message };
  }
  if (status === 401 || code.includes('invalid_api_key') || code.includes('missing_permissions')) {
    return { type: 'invalid_api_key', message: detail.message };
  }
  if (status === 429) return { type: 'rate_limited', message: detail.message };
  if (status === 400 || status === 422) return { type: 'invalid_input', message: detail.message };
  return { type: 'http', status, message: detail.message };
}
