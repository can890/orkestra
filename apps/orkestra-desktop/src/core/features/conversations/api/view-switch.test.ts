import { describe, expect, it } from 'vitest';
import { conversationConfig } from '@core/primitives/conversations/api/conversation-config';
import {
  canSwitchConversationView,
  configForConversationView,
  hasResumableProviderSession,
  supportsConversationViewSwitch,
} from './view-switch';

describe('conversation view configuration', () => {
  it('preserves settings through a serialized terminal round trip without replaying prompts', () => {
    const chat = {
      version: '1' as const,
      type: 'acp' as const,
      model: 'model',
      autoApprove: false,
      modeId: 'plan',
      effort: 'high',
      collaborationMode: 'plan',
      initialQueue: [{ text: 'already sent' }],
    };
    const terminal = configForConversationView(chat, 'pty');
    expect(terminal).toMatchObject({ type: 'pty', requireResume: true, autoApprove: false });
    expect(terminal).not.toHaveProperty('initialQueue');
    const saved = conversationConfig.parseJson(conversationConfig.serialize(terminal));
    if (!saved) throw new Error('Config did not round trip');
    const restored = configForConversationView(saved, 'acp');
    const { initialQueue: _, ...settings } = chat;
    expect(restored).toEqual(settings);
  });
  it('offers conversion only for providers whose CLI and ACP adapter share sessions', () => {
    for (const provider of ['claude', 'codex', 'grok', 'kimi'])
      expect(supportsConversationViewSwitch(provider)).toBe(true);
    expect(supportsConversationViewSwitch('gemini')).toBe(false);
    expect(supportsConversationViewSwitch('glm')).toBe(false);
    expect(supportsConversationViewSwitch(null)).toBe(false);
  });
  it('requires the provider-native session id before switching', () => {
    // Claude, Orkestra'nın seçtiği kimlikle oturum açar.
    expect(hasResumableProviderSession('claude', 'c1', 'c1')).toBe(true);
    // Diğerlerinde terminal kaydı kanca gerçek kimliği bildirene kadar konuşma kimliğini taşır.
    for (const provider of ['codex', 'grok', 'kimi'])
      expect(hasResumableProviderSession(provider, 'c1', 'c1')).toBe(false);
    expect(hasResumableProviderSession('grok', 'c1', '01a10889-02e1-7043-8beb-c8071aa18201')).toBe(
      true
    );
    expect(hasResumableProviderSession('kimi', 'c1', 'session_ebdc4615')).toBe(true);
    expect(hasResumableProviderSession('kimi', 'c1', 'ebdc4615')).toBe(false);
    expect(hasResumableProviderSession('grok', 'c1', null)).toBe(false);
    expect(canSwitchConversationView('grok', 'c1', undefined)).toBe(false);
    expect(canSwitchConversationView('kimi', 'c1', 'session_x')).toBe(true);
    expect(canSwitchConversationView('gemini', 'c1', 'native')).toBe(false);
  });
});
