import { defineCommand } from '@core/primitives/commands/api';

// No default keybinding: avoids conflicts with existing shortcuts.
export const openBoardCommand = defineCommand({
  id: 'board.open',
  title: 'Open Board',
  description: 'See several tasks side by side',
  category: 'App',
  icon: 'layout-grid',
});

export const BOARD_COMMAND_DEFS = [openBoardCommand] as const;
