import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { moveToNewContextCommand } from './commands';

export const CONVERSATION_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: moveToNewContextCommand,
    aliases: [
      'bağlam devri',
      'baglam devri',
      'yeni bağlama taşı',
      'yeni sohbete taşı',
      'bağlam doldu',
      'context handoff',
      'devret',
    ],
  }),
] as const;
