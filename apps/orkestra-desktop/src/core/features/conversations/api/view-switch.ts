import type { ConversationConfig } from '@core/primitives/conversations/api';

/**
 * Sohbet (ACP) ile terminal (TUI) arasında aynı oturumla geçebilen sağlayıcılar. Her birinin CLI'si
 * ve ACP adaptörü aynı oturum deposunu ve kimliğini paylaşır:
 * - claude: Orkestra'nın seçtiği `--session-id` kimliği; ACP `loadSession` ve `--resume <id>`.
 * - codex: sağlayıcının ürettiği kimlik; ACP `loadSession` ve `codex resume <id>`.
 * - grok: `~/.grok/sessions/<cwd>/<id>`; `grok agent stdio` `loadSession` destekler, TUI `-r <id>`.
 * - kimi: `~/.kimi-code/sessions/...` (`session_<uuid>`); `kimi acp` `loadSession` destekler,
 *   TUI `-S <id>`.
 */
const VIEW_SWITCH_PROVIDERS = new Set(['claude', 'codex', 'grok', 'kimi']);

/**
 * Yeni oturumda Orkestra'nın seçtiği kimliği kabul etmeyen sağlayıcılar. Terminalde başlatılan bir
 * konuşmanın kaydı, kanca gerçek kimliği bildirene kadar konuşma kimliğini taşır; bu kimlikle ne
 * ACP `loadSession` ne de CLI devam bayrağı çalışır.
 */
const PROVIDER_MINTED_SESSION_IDS = new Set(['codex', 'grok', 'kimi']);

export function supportsConversationViewSwitch(provider: string | null): boolean {
  return provider !== null && VIEW_SWITCH_PROVIDERS.has(provider);
}

/** Kayıtlı oturum kimliği, sağlayıcının her iki görünümde de devam edebileceği gerçek kimlik mi? */
export function hasResumableProviderSession(
  provider: string | null,
  conversationId: string,
  providerSessionId: string | null | undefined
): providerSessionId is string {
  if (!providerSessionId) return false;
  if (provider !== null && PROVIDER_MINTED_SESSION_IDS.has(provider)) {
    if (providerSessionId === conversationId) return false;
    // Kimi oturum kimlikleri her zaman `session_` önekiyle üretilir.
    if (provider === 'kimi' && !providerSessionId.startsWith('session_')) return false;
  }
  return true;
}

/** Görünüm değiştirme eylemi bu konuşma için şu anda çalışabilir mi? */
export function canSwitchConversationView(
  provider: string | null,
  conversationId: string,
  providerSessionId: string | null | undefined
): boolean {
  return (
    supportsConversationViewSwitch(provider) &&
    hasResumableProviderSession(provider, conversationId, providerSessionId)
  );
}

export function configForConversationView(
  config: ConversationConfig,
  type: 'pty' | 'acp'
): ConversationConfig {
  const common = { version: '1' as const, model: config.model, autoApprove: config.autoApprove };
  const chatOptions =
    config.type === 'acp'
      ? {
          modeId: config.modeId,
          effort: config.effort,
          collaborationMode: config.collaborationMode,
        }
      : config.chatOptions;
  // Aynı oturuma dönerken başlangıç mesajları ve kuyruk yeniden gönderilmez.
  return type === 'acp'
    ? { ...common, type, ...chatOptions }
    : { ...common, type, chatOptions, requireResume: true };
}
