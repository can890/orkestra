import { secret, type Secret } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import type { TextGenerationSettings } from '@core/primitives/app-settings/api';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  buildHeuristicPromptSuggestions,
  TEXT_GENERATION_API_KEY_SECRET,
  TextGenerationService,
} from './text-generation-service';

function createMemorySecretStore(): SecretStore {
  const map = new Map<string, Secret<string>>();
  return {
    getSecret: async (key) => map.get(key) ?? null,
    setSecret: async (key, val) => {
      map.set(key, val);
    },
    deleteSecret: async (key) => {
      map.delete(key);
    },
  };
}

describe('TextGenerationService', () => {
  it('calls OpenAI-compatible chat completions endpoint with bearer key', async () => {
    const secrets = createMemorySecretStore();
    await secrets.setSecret(
      TEXT_GENERATION_API_KEY_SECRET,
      secret('sk-test-123', TEXT_GENERATION_API_KEY_SECRET)
    );
    const settings: TextGenerationSettings = {
      enabled: true,
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      autoTitleTasks: true,
      promptSuggestionsEnabled: true,
    };

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.example.com/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
      return new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'Kısa Görev Başlığı' } }],
        }),
        { status: 200 }
      );
    });

    const service = new TextGenerationService({
      secrets,
      getSettings: async () => settings,
      fetch: fetchMock,
      isSecureStorageAvailable: () => true,
    });

    const title = await service.generateTaskTitle('Lütfen giriş hatasını düzelt.');
    expect(title).toBe('Kısa Görev Başlığı');
  });

  it('calls Anthropic messages endpoint when provider is anthropic', async () => {
    const secrets = createMemorySecretStore();
    await secrets.setSecret(
      TEXT_GENERATION_API_KEY_SECRET,
      secret('sk-ant-test', TEXT_GENERATION_API_KEY_SECRET)
    );
    const settings: TextGenerationSettings = {
      enabled: true,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-5-haiku-latest',
      autoTitleTasks: true,
      promptSuggestionsEnabled: true,
    };

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
      expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
      return new Response(
        JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          content: [{ type: 'text', text: '["Öneri 1", "Öneri 2", "Öneri 3"]' }],
        }),
        { status: 200 }
      );
    });

    const service = new TextGenerationService({
      secrets,
      getSettings: async () => settings,
      fetch: fetchMock,
      isSecureStorageAvailable: () => true,
    });

    const res = await service.generatePromptSuggestions({
      lastAssistantText: 'Dosyalar güncellendi.',
    });
    expect(res).toEqual({
      source: 'llm',
      suggestions: ['Öneri 1', 'Öneri 2', 'Öneri 3'],
    });
  });

  it('falls back to heuristic prompt suggestions when API is disabled or misses key', async () => {
    const secrets = createMemorySecretStore();
    const service = new TextGenerationService({
      secrets,
      getSettings: async () => ({
        enabled: false,
        provider: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        autoTitleTasks: true,
        promptSuggestionsEnabled: true,
      }),
      fetch: vi.fn(),
      isSecureStorageAvailable: () => true,
    });

    const res = await service.generatePromptSuggestions({
      lastAssistantText: 'vitest başarısız oldu',
    });
    expect(res.source).toBe('heuristic');
    expect(res.suggestions).toEqual(buildHeuristicPromptSuggestions('vitest başarısız oldu'));
    expect(res.suggestions.length).toBe(3);
  });
});
