import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { openWorkflowsCommand } from './commands';

export const WORKFLOWS_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: openWorkflowsCommand,
    aliases: ['iş akışları', 'is akislari', 'workflow runs', 'questions'],
  }),
] as const;
