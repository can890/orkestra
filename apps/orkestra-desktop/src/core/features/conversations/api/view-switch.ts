import type { ConversationConfig } from '@core/primitives/conversations/api';

// Bu sağlayıcıların CLI ve ACP adaptörü aynı oturum kimliğini kullanır.
export function supportsConversationViewSwitch(provider: string | null): boolean {
  return provider === 'claude' || provider === 'codex';
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
