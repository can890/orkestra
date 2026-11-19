import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { openBoardCommand } from './commands';

export const BOARD_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({ command: openBoardCommand, aliases: ['pano', 'grid', 'tiles'] }),
] as const;
