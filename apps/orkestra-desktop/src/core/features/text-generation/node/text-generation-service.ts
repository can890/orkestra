import { err, ok, secret, type Result } from '@orkestra/shared';
import type {
  TextGenerationError,
  TextGenerationModelSummary,
  TextGenerationStatus,
} from '@core/features/text-generation/api/contract';
import type { TextGenerationSettings } from '@core/primitives/app-settings/api';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

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

export function buildHeuristicPromptSuggestions(lastAssistantText: string): string[] {
  const lower = lastAssistantText.toLowerCase();
  const suggestions: string[] = [];

  if (/(test|spec|vitest|jest|pytest|hata|error|fail)/i.test(lower)) {
    suggestions.push('İlgili testleri çalıştır ve kalan hataları doğrula');
  } else {
    suggestions.push('Bu değişiklikler için birim testi ekle ve çalıştır');
  }

  if (/(diff|dosya|file|bileşen|component|refactor|fonksiyon|api)/i.test(lower)) {
    suggestions.push('Olası edge case ve tip güvenliği açıklarını gözden geçir');
  } else {
    suggestions.push('Bir sonraki somut uygulama adımına geç');
  }

  suggestions.push('Değişikliklerin kısa teknik özetini ve olası risklerini listele');
  return suggestions.slice(0, 3);
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

function parseJsonLinesOrArray(rawText: string): string[] {
  const trimmed = rawText.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed: unknown = JSON.parse(fenced);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length >= 4 && item.length <= 140)
        .slice(0, 3);
    }
  } catch {
    // Satır bazlı metin ayrıştırmasına düş.
  }
  return fenced
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').replace(/^["']|["']$/g, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 140)
    .slice(0, 3);
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
    const keyResult = await this.readApiKey();
    if (!keyResult.success) return keyResult;

    const fallbackBase =
      settings.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    const baseUrl = normalizeBaseUrl(settings.baseUrl, fallbackBase);
    if (!baseUrl) {
      return err({ type: 'invalid_input', message: 'Geçersiz Base URL adresi.' });
    }

    if (settings.provider === 'anthropic') {
      try {
        const res = await this.deps.fetch(buildAnthropicUrl(baseUrl, '/models'), {
          method: 'GET',
          headers: {
            'x-api-key': keyResult.data,
            'anthropic-version': '2023-06-01',
          },
          signal: this.timeoutSignal(),
        });
        if (!res.ok) {
          return ok([...ANTHROPIC_DEFAULT_MODELS]);
        }
        const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
        const items = (json.data ?? [])
          .filter((item): item is { id: string; display_name?: string } => typeof item.id === 'string')
          .map((item) => ({ id: item.id, name: item.display_name || item.id }));
        return ok(items.length > 0 ? items : [...ANTHROPIC_DEFAULT_MODELS]);
      } catch {
        return ok([...ANTHROPIC_DEFAULT_MODELS]);
      }
    }

    try {
      const res = await this.deps.fetch(buildOpenAiUrl(baseUrl, '/models'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${keyResult.data}`,
        },
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

    const keyResult = await this.readApiKey();
    if (!keyResult.success) return keyResult;

    const fallbackBase =
      settings.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    const baseUrl = normalizeBaseUrl(settings.baseUrl, fallbackBase);
    if (!baseUrl) {
      return err({ type: 'invalid_input', message: 'Geçersiz Base URL adresi.' });
    }

    const model =
      settings.model.trim() ||
      (settings.provider === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini');
    const maxTokens = input.maxTokens ?? 512;
    const temperature = input.temperature ?? 0.2;

    try {
      if (settings.provider === 'anthropic') {
        const res = await this.deps.fetch(buildAnthropicUrl(baseUrl, '/messages'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': keyResult.data,
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

      const res = await this.deps.fetch(buildOpenAiUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${keyResult.data}`,
        },
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
        'Sen bir geliştirici asistanısın. Verilen görev isteğinden 3 ila 6 kelimelik kısa, net, tırnaksız bir başlık üret. Yalnızca başlığı döndür.',
      prompt: trimmedPrompt,
      maxTokens: 32,
      temperature: 0.2,
    });
    if (!result.success) {
      this.deps.logger?.warn('TextGenerator başlık üretemedi, sezgisel moda düşülüyor', {
        error: result.error.type,
      });
      return null;
    }
    const clean = result.data.text
      .split(/\r?\n/)[0]
      ?.replace(/^["'«»“”#*-]+\s*|\s*["'«»“”.:;!?]+$/g, '')
      .trim()
      .slice(0, 56);
    return clean && clean.length >= 2 ? clean : null;
  }

  async generatePromptSuggestions(input: {
    lastAssistantText: string;
    projectName?: string;
    taskName?: string;
  }): Promise<{ source: 'llm' | 'heuristic'; suggestions: string[] }> {
    const fallback = buildHeuristicPromptSuggestions(input.lastAssistantText);
    const settings = await this.deps.getSettings();
    if (!settings.enabled || !settings.promptSuggestionsEnabled) {
      return { source: 'heuristic', suggestions: fallback };
    }

    const result = await this.generateText({
      systemPrompt:
        'Asistanın son yanıtına göre kullanıcının bir sonraki adımda tıklayabileceği 3 kısa, somut takip istemi öner. Yanıtı yalnızca 3 elemanlı bir JSON string dizisi olarak ver.',
      prompt: [
        input.projectName ? `Proje: ${input.projectName}` : '',
        input.taskName ? `Görev: ${input.taskName}` : '',
        `Son yanıt:\n${input.lastAssistantText.slice(0, 3000)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 180,
      temperature: 0.4,
    });
    if (!result.success) {
      return { source: 'heuristic', suggestions: fallback };
    }
    const parsed = parseJsonLinesOrArray(result.data.text);
    if (parsed.length === 0) {
      return { source: 'heuristic', suggestions: fallback };
    }
    return { source: 'llm', suggestions: parsed };
  }
}
