import { secret, type Secret } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_PREFERENCES,
  type VoicePreferences,
} from '@core/features/voice/api/contract';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  createVoiceService,
  ELEVENLABS_API_KEY_SECRET,
  type VoiceFetch,
  type VoiceServiceDeps,
} from './voice-service';

const API_KEY = 'sk_super_secret_value_1234';

function memorySecrets(initial?: string): SecretStore & { values: Map<string, Secret<string>> } {
  const values = new Map<string, Secret<string>>();
  if (initial) values.set(ELEVENLABS_API_KEY_SECRET, secret(initial));
  return {
    values,
    async getSecret(key: string) {
      return values.get(key) ?? null;
    },
    async setSecret(key: string, value: Secret<string>) {
      values.set(key, value);
    },
    async deleteSecret(key: string) {
      values.delete(key);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(overrides: Partial<VoiceServiceDeps> & { apiKey?: string } = {}) {
  const { apiKey, ...depsOverrides } = overrides;
  const secrets = memorySecrets(apiKey);
  let stored: Partial<VoicePreferences> | null = null;
  const warn = vi.fn();
  const fetch = vi.fn<VoiceFetch>(async () => jsonResponse({ voices: [] }));
  const service = createVoiceService({
    secrets,
    preferences: {
      get: async () => stored,
      set: async (next) => {
        stored = next;
      },
    },
    fetch,
    isSecureStorageAvailable: () => true,
    microphone: {
      getAccess: () => 'granted',
      requestAccess: async () => 'granted',
      openSettings: async () => {},
    },
    logger: { warn },
    ...depsOverrides,
  });
  return { service, secrets, fetch, warn, getStored: () => stored };
}

describe('VoiceService anahtar yönetimi', () => {
  it('anahtar yokken ağ çağrısı yapmadan missing_api_key döner', async () => {
    const { service, fetch } = setup();
    expect(await service.listVoices()).toEqual({
      success: false,
      error: { type: 'missing_api_key' },
    });
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/webm' });
    expect(await service.transcribe({ audio, fileName: 'a.webm', mimeType: 'audio/webm' })).toEqual(
      { success: false, error: { type: 'missing_api_key' } }
    );
    expect(await service.synthesize({ text: 'merhaba' })).toEqual({
      success: false,
      error: { type: 'missing_api_key' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('anahtarı Secret olarak saklar; durum yalnızca varlığını bildirir', async () => {
    const { service, secrets } = setup();
    expect((await service.getStatus()).hasApiKey).toBe(false);
    expect(await service.setApiKey(`  ${API_KEY}  `)).toEqual({ success: true, data: undefined });
    const stored = secrets.values.get(ELEVENLABS_API_KEY_SECRET);
    expect(stored?.expose()).toBe(API_KEY);
    // Secret, JSON dönüşümünde değeri sızdırmaz.
    expect(JSON.stringify({ stored })).not.toContain(API_KEY);
    const status = await service.getStatus();
    expect(status.hasApiKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain(API_KEY);

    expect((await service.clearApiKey()).success).toBe(true);
    expect((await service.getStatus()).hasApiKey).toBe(false);
  });

  it('boşluk içeren anahtarı ve güvensiz depolamayı reddeder', async () => {
    const { service } = setup();
    expect((await service.setApiKey('iki parça')).success).toBe(false);
    const insecure = setup({ isSecureStorageAvailable: () => false });
    const result = await insecure.service.setApiKey(API_KEY);
    expect(result).toMatchObject({ success: false, error: { type: 'storage_unavailable' } });
    expect(insecure.secrets.values.size).toBe(0);
  });

  it('anahtarı yalnızca xi-api-key başlığında gönderir, hata ve günlüklere sızdırmaz', async () => {
    const { service, fetch, warn } = setup({ apiKey: API_KEY });
    fetch.mockResolvedValueOnce(
      jsonResponse({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401)
    );
    const result = await service.listVoices();
    expect(result).toEqual({
      success: false,
      error: { type: 'invalid_api_key', message: 'Invalid API key' },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).not.toContain(API_KEY);
    expect(init.headers['xi-api-key']).toBe(API_KEY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });

  it('ağ hatasını network olarak döner ve anahtarı günlüğe yazmaz', async () => {
    const { service, fetch, warn } = setup({ apiKey: API_KEY });
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await service.testConnection()).toEqual({
      success: false,
      error: { type: 'network', message: 'fetch failed' },
    });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });
});

describe('VoiceService istekleri', () => {
  it('ses listesini sayfalar halinde toplar', async () => {
    const { service, fetch } = setup({ apiKey: API_KEY });
    fetch
      .mockResolvedValueOnce(
        jsonResponse({
          voices: [{ voice_id: 'a', name: 'A' }],
          has_more: true,
          next_page_token: 'p2',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ voices: [{ voice_id: 'b', name: 'B' }] }));
    const result = await service.listVoices();
    expect(result.success && result.data.map((voice) => voice.voiceId)).toEqual(['a', 'b']);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('next_page_token')).toBe('p2');
  });

  it('dikteyi kayıtlı dil tercihiyle yazıya döker', async () => {
    const { service, fetch } = setup({ apiKey: API_KEY });
    await service.setPreferences({ sttLanguage: 'en' });
    fetch.mockResolvedValueOnce(jsonResponse({ text: 'hello there', language_code: 'en' }));
    const audio = new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' });
    const result = await service.transcribe({
      audio,
      fileName: 'dikte.webm',
      mimeType: 'audio/webm',
    });
    expect(result).toEqual({ success: true, data: { text: 'hello there', languageCode: 'en' } });
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(form.get('language_code')).toBe('en');
  });

  it('ses dışı dosyaları reddeder', async () => {
    const { service, fetch } = setup({ apiKey: API_KEY });
    const result = await service.transcribe({
      audio: new Blob(['x']),
      fileName: 'a.txt',
      mimeType: 'text/plain',
    });
    expect(result).toMatchObject({ success: false, error: { type: 'invalid_input' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sesli yanıtı tercih edilen sesle üretir', async () => {
    const { service, fetch } = setup({ apiKey: API_KEY });
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'audio/mpeg' } })
    );
    const result = await service.synthesize({ text: '  Merhaba  ' });
    expect(result.success && Array.from(result.data.bytes)).toEqual([9, 8, 7]);
    expect(result.success && result.data.mimeType).toBe('audio/mpeg');
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe(
      `/v1/text-to-speech/${DEFAULT_VOICE_PREFERENCES.ttsVoiceId}`
    );
    expect(JSON.parse(init.body as string)).toMatchObject({ text: 'Merhaba' });
  });

  it('geçersiz tercihleri saklamaz, eksik tercihleri varsayılanla tamamlar', async () => {
    const { service, getStored } = setup();
    expect((await service.setPreferences({ sttLanguage: 'türkçe!' })).success).toBe(false);
    expect(getStored()).toBeNull();
    expect(await service.getPreferences()).toEqual(DEFAULT_VOICE_PREFERENCES);
    const saved = await service.setPreferences({ ttsModelId: 'eleven_flash_v2_5' });
    expect(saved).toEqual({
      success: true,
      data: { ...DEFAULT_VOICE_PREFERENCES, ttsModelId: 'eleven_flash_v2_5' },
    });
  });
});
