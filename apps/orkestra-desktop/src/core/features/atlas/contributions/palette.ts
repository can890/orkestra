import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { toggleAtlasCardSkipCommand, writeAtlasCardCommand } from './commands';

export const ATLAS_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: writeAtlasCardCommand,
    aliases: ['atlas kart', 'oturum kartı', 'session card'],
  }),
  defineCommandPaletteItem({
    command: toggleAtlasCardSkipCommand,
    aliases: ['atlas kart yazma', 'no atlas card'],
  }),
] as const;
