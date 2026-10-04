import { describe, expect, it } from 'vitest';
import { conversationConfig } from '@core/primitives/conversations/api/conversation-config';
import { configForConversationView, supportsConversationViewSwitch } from './view-switch';

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
  it('does not offer conversion for unrelated providers', () => {
    expect(supportsConversationViewSwitch('claude')).toBe(true);
    expect(supportsConversationViewSwitch('codex')).toBe(true);
    expect(supportsConversationViewSwitch('gemini')).toBe(false);
  });
});
