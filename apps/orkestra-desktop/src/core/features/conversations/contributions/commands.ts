import { defineCommand } from '@core/primitives/commands/api';
import { keybinding } from '@core/primitives/keybindings/api';

/**
 * İstem zulası: oluşturucu doluysa taslağı zulaya alır ve temizler; boşsa tek girdiyi
 * geri yükler ya da zula menüsünü açar. Klavye ayarlarından yeniden atanabilir.
 */
export const stashPromptCommand = defineCommand({
  id: 'conversations.stashPrompt',
  title: 'Stash Prompt',
  description:
    'Stash the composer prompt for later, or restore a stashed prompt when the composer is empty',
  category: 'Conversations',
  icon: 'bookmark',
  keybinding: keybinding.settings('stashPrompt', 'Mod+S'),
});

/**
 * Bağlam devri: sohbeti aynı görevde yeni bir sohbete taşır; ajan devir notu yazar ve yeni sohbet
 * kaldığı yerden kendiliğinden devam eder.
 */
export const moveToNewContextCommand = defineCommand({
  id: 'conversations.moveToNewContext',
  title: 'Move Conversation to New Context',
  description:
    'Hand the work over to a new conversation in the same task, with a hand-over note from the agent',
  category: 'Conversations',
  icon: 'arrow-right-left',
});

export const CONVERSATION_COMPOSER_COMMAND_DEFS = [
  stashPromptCommand,
  moveToNewContextCommand,
] as const;
