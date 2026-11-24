import { ATLAS_COMMAND_PALETTE_ITEMS } from '@core/features/atlas/contributions/palette';
import { BOARD_COMMAND_PALETTE_ITEMS } from '@core/features/board/contributions/palette';
import { DEV_PERF_COMMAND_PALETTE_ITEMS } from '@core/features/dev-perf/contributions/palette';
import { TASK_COMMAND_PALETTE_ITEMS } from '@core/features/tasks/contributions/palette';
import { WORKBENCH_COMMAND_PALETTE_ITEMS } from '@core/features/workbench/contributions/palette';
import { WORKFLOWS_COMMAND_PALETTE_ITEMS } from '@core/features/workflows/contributions/palette';
import { defineCommandPaletteCatalog } from '@core/primitives/palette/api';
import { COMMAND_CATALOG } from './command-catalog';

export const COMMAND_PALETTE_CATALOG = defineCommandPaletteCatalog(COMMAND_CATALOG, [
  ...WORKBENCH_COMMAND_PALETTE_ITEMS,
  ...TASK_COMMAND_PALETTE_ITEMS,
  ...DEV_PERF_COMMAND_PALETTE_ITEMS,
  ...BOARD_COMMAND_PALETTE_ITEMS,
  ...WORKFLOWS_COMMAND_PALETTE_ITEMS,
  ...ATLAS_COMMAND_PALETTE_ITEMS,
] as const);

export type CommandPaletteCommandId =
  (typeof COMMAND_PALETTE_CATALOG.items)[number]['command']['id'];
