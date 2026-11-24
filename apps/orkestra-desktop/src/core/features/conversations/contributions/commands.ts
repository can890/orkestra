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

export const CONVERSATION_COMPOSER_COMMAND_DEFS = [stashPromptCommand] as const;
