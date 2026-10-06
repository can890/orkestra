import { describe, expect, it } from 'vitest';
import {
  buildListVoicesRequest,
  buildSpeechRequest,
  buildTranscriptionRequest,
  ELEVENLABS_STT_MODEL,
  mapHttpError,
  parseErrorDetail,
  parseTranscription,
  parseVoicesPage,
} from './elevenlabs-requests';

describe('buildTranscriptionRequest', () => {
  it('Scribe modeline çok parçalı istek kurar ve dili ekler', () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const request = buildTranscriptionRequest({
      apiKey: 'sk_test',
      audio,
      fileName: 'dikte.webm',
      language: 'TR',
    });
    expect(request.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({ 'xi-api-key': 'sk_test' });
    const form = request.init.body as FormData;
    expect(form.get('model_id')).toBe(ELEVENLABS_STT_MODEL);
    expect(form.get('language_code')).toBe('tr');
    const file = form.get('file') as File;
    expect(file.name).toBe('dikte.webm');
    expect(file.size).toBe(3);
  });

  it('otomatik algılamada language_code göndermez', () => {
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });
    const auto = buildTranscriptionRequest({ apiKey: 'k', audio, fileName: 'a', language: 'auto' });
    const none = buildTranscriptionRequest({ apiKey: 'k', audio, fileName: 'a' });
    expect((auto.init.body as FormData).has('language_code')).toBe(false);
    expect((none.init.body as FormData).has('language_code')).toBe(false);
  });
});

describe('buildSpeechRequest', () => {
  it('ses kimliğini yola, biçimi sorguya, metni JSON gövdeye koyar', () => {
    const request = buildSpeechRequest({
      apiKey: 'sk_test',
      text: 'Merhaba',
      voiceId: 'abc/../x',
      modelId: 'eleven_multilingual_v2',
      languageCode: 'tr',
    });
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/abc%2F..%2Fx'
    );
    expect(url.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(request.init.headers['xi-api-key']).toBe('sk_test');
    expect(request.init.headers['content-type']).toBe('application/json');
    // language_code yalnızca flash modelinde desteklenir.
    expect(JSON.parse(request.init.body as string)).toEqual({
      text: 'Merhaba',
      model_id: 'eleven_multilingual_v2',
    });
  });

  it('flash modelinde dil kodunu gönderir', () => {
    const request = buildSpeechRequest({
      apiKey: 'k',
      text: 'Selam',
      voiceId: 'v',
      modelId: 'eleven_flash_v2_5',
      languageCode: 'tr',
    });
    expect(JSON.parse(request.init.body as string)).toMatchObject({ language_code: 'tr' });
  });
});

describe('buildListVoicesRequest', () => {
  it('v2 ses listesini sayfa boyutu ve sayfa belirteciyle ister', () => {
    const request = buildListVoicesRequest({ apiKey: 'k', nextPageToken: 'tok' });
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v2/voices');
    expect(url.searchParams.get('page_size')).toBe('100');
    expect(url.searchParams.get('next_page_token')).toBe('tok');
    expect(request.init).toEqual({ method: 'GET', headers: { 'xi-api-key': 'k' } });
  });
});

describe('yanıt çözümleme', () => {
  it('tek ve çok kanallı transkriptleri çözer', () => {
    expect(parseTranscription({ text: ' merhaba dünya ', language_code: 'tur' })).toEqual({
      text: 'merhaba dünya',
      languageCode: 'tur',
    });
    expect(
      parseTranscription({
        transcripts: [
          { text: 'bir', language_code: 'tr' },
          { text: 'iki', language_code: 'tr' },
        ],
      })
    ).toEqual({ text: 'bir iki', languageCode: 'tr' });
    expect(parseTranscription({ nope: true })).toBeNull();
  });

  it('ses listesini özetler ve sayfa belirtecini yalnızca has_more ise döner', () => {
    const page = parseVoicesPage({
      voices: [
        {
          voice_id: 'v1',
          name: 'George',
          category: 'premade',
          labels: { gender: 'male', accent: 'british' },
          preview_url: 'https://example.test/p.mp3',
        },
        { voice_id: '', name: 'eksik' },
      ],
      has_more: true,
      next_page_token: 'next',
    });
    expect(page).toEqual({
      voices: [
        {
          voiceId: 'v1',
          name: 'George',
          category: 'premade',
          description: 'male · british',
          previewUrl: 'https://example.test/p.mp3',
        },
      ],
      nextPageToken: 'next',
    });
    expect(parseVoicesPage({ voices: [], has_more: false, next_page_token: 'x' })).toEqual({
      voices: [],
      nextPageToken: undefined,
    });
  });
});

describe('hata eşleme', () => {
  it('ElevenLabs hata gövdesi biçimlerini okur', () => {
    expect(parseErrorDetail('{"detail":{"status":"invalid_api_key","message":"Bad key"}}')).toEqual(
      { status: 'invalid_api_key', message: 'Bad key' }
    );
    expect(parseErrorDetail('{"detail":[{"msg":"field required"}]}')).toEqual({
      message: 'field required',
    });
    expect(parseErrorDetail('düz metin')).toEqual({ message: 'düz metin' });
  });

  it('durum kodlarını alan hatalarına çevirir', () => {
    expect(mapHttpError(401, '{"detail":{"status":"invalid_api_key","message":"x"}}').type).toBe(
      'invalid_api_key'
    );
    expect(mapHttpError(401, '{"detail":{"status":"quota_exceeded","message":"x"}}').type).toBe(
      'quota_exceeded'
    );
    expect(mapHttpError(429, '{}').type).toBe('rate_limited');
    expect(mapHttpError(422, '{"detail":"bad"}')).toEqual({
      type: 'invalid_input',
      message: 'bad',
    });
    expect(mapHttpError(503, 'down')).toEqual({ type: 'http', status: 503, message: 'down' });
  });
});
