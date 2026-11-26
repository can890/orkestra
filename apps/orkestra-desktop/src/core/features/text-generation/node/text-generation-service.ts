import { err, ok, secret, type Result } from '@orkestra/shared';
import type {
  PromptSuggestionTurnActivity,
  TextGenerationError,
  TextGenerationModelSummary,
  TextGenerationStatus,
} from '@core/features/text-generation/api/contract';
import type { TextGenerationSettings } from '@core/primitives/app-settings/api';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  analyzeTurnFacts,
  buildHeuristicPromptSuggestions,
  buildLlmSuggestionPrompt,
  filterIllogicalSuggestions,
  parseLlmSuggestionArray,
} from './prompt-suggestions';

export { buildHeuristicPromptSuggestions };

export const TEXT_GENERATION_API_KEY_SECRET = 'textGeneration.apiKey';
const REQUEST_TIMEOUT_MS = 15_000;

export type TextGenerationFetch = (
  url: string,
  init: RequestInit & { signal?: AbortSignal }
) => Promise<Response>;

type TextGenerationLogger = {
  warn(message: string, context?: Record<string, unknown>): void;
};

export type TextGenerationServiceDeps = {
  secrets: SecretStore;
  getSettings: () => Promise<TextGenerationSettings>;
  fetch: TextGenerationFetch;
  isSecureStorageAvailable: () => boolean;
  logger?: TextGenerationLogger;
  timeoutMs?: number;
};

const ANTHROPIC_DEFAULT_MODELS: readonly TextGenerationModelSummary[] = [
  { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku (Hızlı)' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
];

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(rawUrl: string, fallback: string): string | null {
  const trimmed = rawUrl.trim() || fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function buildOpenAiUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${cleanPath}`;
}

function buildAnthropicUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (baseUrl.endsWith('/v1')) {
    return `${baseUrl}${cleanPath}`;
  }
  return `${baseUrl}/v1${cleanPath}`;
}

export class TextGenerationService {
  constructor(private readonly deps: TextGenerationServiceDeps) {}

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  }

  private async readApiKey(): Promise<Result<string, TextGenerationError>> {
    try {
      const wrapped = await this.deps.secrets.getSecret(TEXT_GENERATION_API_KEY_SECRET);
      if (!wrapped) {
        return err({
          type: 'missing_api_key',
          message: 'Text Generator API anahtarı henüz kaydedilmedi.',
        });
      }
      const value = wrapped.expose().trim();
      if (!value) {
        return err({
          type: 'missing_api_key',
          message: 'Kayıtlı Text Generator API anahtarı boş.',
        });
      }
      return ok(value);
    } catch (error) {
      return err({
        type: 'storage_unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getStatus(): Promise<TextGenerationStatus> {
    const settings = await this.deps.getSettings();
    let hasApiKey = false;
    if (this.deps.isSecureStorageAvailable()) {
      try {
        hasApiKey = (await this.deps.secrets.getSecret(TEXT_GENERATION_API_KEY_SECRET)) !== null;
      } catch {
        hasApiKey = false;
      }
    }
    return {
      hasApiKey,
      secureStorageAvailable: this.deps.isSecureStorageAvailable(),
      enabled: settings.enabled,
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
    };
  }

  async setApiKey(apiKey: string): Promise<Result<void, TextGenerationError>> {
    if (!this.deps.isSecureStorageAvailable()) {
      return err({
        type: 'storage_unavailable',
        message: 'Sistemde güvenli anahtar depolaması kullanılabilir değil.',
      });
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return err({ type: 'invalid_input', message: 'API anahtarı boş olamaz.' });
    }
    await this.deps.secrets.setSecret(
      TEXT_GENERATION_API_KEY_SECRET,
      secret(trimmed, TEXT_GENERATION_API_KEY_SECRET)
    );
    return ok(undefined);
  }

  async clearApiKey(): Promise<Result<void, TextGenerationError>> {
    await this.deps.secrets.deleteSecret(TEXT_GENERATION_API_KEY_SECRET);
    return ok(undefined);
  }

  async listModels(): Promise<Result<TextGenerationModelSummary[], TextGenerationError>> {
    const settings = await this.deps.getSettings();
    const fallbackBase =
      settings.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    const baseUrl = normalizeBaseUrl(settings.baseUrl, fallbackBase);
    if (!baseUrl) {
      return err({ type: 'invalid_input', message: 'Geçersiz Base URL adresi.' });
    }
    const keyResult = await this.readApiKey();
    const allowKeyless = settings.provider === 'openai-compatible' && isLoopbackUrl(baseUrl);
    if (!keyResult.success && !allowKeyless) return keyResult;
    const apiKey = keyResult.success ? keyResult.data : null;

    if (settings.provider === 'anthropic' && apiKey) {
      try {
        const res = await this.deps.fetch(buildAnthropicUrl(baseUrl, '/models'), {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: this.timeoutSignal(),
        });
        if (!res.ok) {
          return ok([...ANTHROPIC_DEFAULT_MODELS]);
        }
        const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
        const items = (json.data ?? [])
          .filter(
            (item): item is { id: string; display_name?: string } => typeof item.id === 'string'
          )
          .map((item) => ({ id: item.id, name: item.display_name || item.id }));
        return ok(items.length > 0 ? items : [...ANTHROPIC_DEFAULT_MODELS]);
      } catch {
        return ok([...ANTHROPIC_DEFAULT_MODELS]);
      }
    }

    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await this.deps.fetch(buildOpenAiUrl(baseUrl, '/models'), {
        method: 'GET',
        headers,
        signal: this.timeoutSignal(),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        return err({
          type: 'http',
          status: res.status,
          message: errText.slice(0, 240) || `HTTP ${res.status}`,
        });
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (json.data ?? [])
        .filter((item): item is { id: string } => typeof item.id === 'string')
        .map((item) => ({ id: item.id, name: item.id }))
        .slice(0, 80);
      return ok(models);
    } catch (error) {
      return err({
        type: 'network',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async testConnection(): Promise<
    Result<{ ok: true; latencyMs: number; modelCount?: number }, TextGenerationError>
  > {
    const started = Date.now();
    const generated = await this.generateText(
      {
        prompt: 'Yanıt olarak yalnızca OK yaz.',
        maxTokens: 16,
        temperature: 0,
      },
      { ignoreEnabledFlag: true }
    );
    if (!generated.success) return generated;
    const modelsResult = await this.listModels();
    return ok({
      ok: true,
      latencyMs: Date.now() - started,
      modelCount: modelsResult.success ? modelsResult.data.length : undefined,
    });
  }

  async generateText(
    input: {
      systemPrompt?: string;
      prompt: string;
      maxTokens?: number;
      temperature?: number;
    },
    opts?: { ignoreEnabledFlag?: boolean }
  ): Promise<Result<{ text: string; model: string }, TextGenerationError>> {
    const settings = await this.deps.getSettings();
    if (!opts?.ignoreEnabledFlag && !settings.enabled) {
      return err({
        type: 'disabled',
        message: 'Text Generator API Genel Ayarlar altında etkin değil.',
      });
    }

    const fallbackBase =
      settings.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    const baseUrl = normalizeBaseUrl(settings.baseUrl, fallbackBase);
    if (!baseUrl) {
      return err({ type: 'invalid_input', message: 'Geçersiz Base URL adresi.' });
    }

    const keyResult = await this.readApiKey();
    const allowKeyless = settings.provider === 'openai-compatible' && isLoopbackUrl(baseUrl);
    if (!keyResult.success && !allowKeyless) return keyResult;
    const apiKey = keyResult.success ? keyResult.data : null;

    const model =
      settings.model.trim() ||
      (settings.provider === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');
    const maxTokens = input.maxTokens ?? 512;
    const temperature = input.temperature ?? 0.2;

    try {
      if (settings.provider === 'anthropic' && apiKey) {
        const res = await this.deps.fetch(buildAnthropicUrl(baseUrl, '/messages'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
            messages: [{ role: 'user', content: input.prompt }],
          }),
          signal: this.timeoutSignal(),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          return err({
            type: 'http',
            status: res.status,
            message: errText.slice(0, 240) || `HTTP ${res.status}`,
          });
        }
        const json = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          model?: string;
        };
        const text = (json.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        return ok({ text, model: json.model ?? model });
      }

      const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
      if (input.systemPrompt) {
        messages.push({ role: 'system', content: input.systemPrompt });
      }
      messages.push({ role: 'user', content: input.prompt });

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await this.deps.fetch(buildOpenAiUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: this.timeoutSignal(),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        return err({
          type: 'http',
          status: res.status,
          message: errText.slice(0, 240) || `HTTP ${res.status}`,
        });
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        model?: string;
      };
      const text = (json.choices?.[0]?.message?.content ?? '').trim();
      return ok({ text, model: json.model ?? model });
    } catch (error) {
      return err({
        type: 'network',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generateTaskTitle(prompt: string): Promise<string | null> {
    const settings = await this.deps.getSettings();
    if (!settings.enabled || !settings.autoTitleTasks) return null;
    const trimmedPrompt = prompt.trim().slice(0, 1500);
    if (!trimmedPrompt) return null;

    const result = await this.generateText({
      systemPrompt:
        'Sen bir geliştirici asistanısın. Verilen istekten en fazla 2 ila 3 kelimelik ve 22 karakteri geçmeyen çok kısa, net, tırnaksız bir başlık üret. Başlığı isteğin yazıldığı dilde yaz. Yalnızca başlığı döndür.',
      prompt: trimmedPrompt,
      maxTokens: 20,
      temperature: 0.2,
    });
    if (!result.success) {
      this.deps.logger?.warn('TextGenerator başlık üretemedi, sezgisel moda düşülüyor', {
        error: result.error.type,
      });
      return null;
    }
    const rawLine =
      result.data.text
        .split(/\r?\n/)[0]
        ?.replace(/^["'«»“”#*-]+\s*|\s*["'«»“”.:;!?]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim() ?? '';
    const words = rawLine.split(' ').filter(Boolean);
    const kept: string[] = [];
    let len = 0;
    for (const word of words) {
      const nextLen = len === 0 ? word.length : len + 1 + word.length;
      if (nextLen > 22) {
        if (kept.length === 0) kept.push(word.slice(0, 22));
        break;
      }
      kept.push(word);
      len = nextLen;
    }
    const clean = kept
      .join(' ')
      .replace(/[,.;:!?]+$/, '')
      .trim();
    return clean && clean.length >= 2 ? clean : null;
  }

  async generatePromptSuggestions(input: {
    lastUserText?: string;
    lastAssistantText: string;
    projectName?: string;
    taskName?: string;
    activity?: PromptSuggestionTurnActivity;
  }): Promise<{ source: 'llm' | 'heuristic'; suggestions: string[] }> {
    const facts = analyzeTurnFacts(input);
    const fallback = buildHeuristicPromptSuggestions(input);
    const settings = await this.deps.getSettings();
    if (!settings.enabled || !settings.promptSuggestionsEnabled) {
      return { source: 'heuristic', suggestions: fallback };
    }

    const { systemPrompt, prompt } = buildLlmSuggestionPrompt(input, facts);
    const result = await this.generateText({
      systemPrompt,
      prompt,
      maxTokens: 180,
      temperature: 0.3,
    });
    if (!result.success) {
      return { source: 'heuristic', suggestions: fallback };
    }
    const parsed = parseLlmSuggestionArray(result.data.text);
    if (parsed === null) {
      return { source: 'heuristic', suggestions: fallback };
    }
    return { source: 'llm', suggestions: filterIllogicalSuggestions(parsed, facts) };
  }
}
