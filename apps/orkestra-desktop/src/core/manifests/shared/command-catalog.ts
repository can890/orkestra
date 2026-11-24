import { BOARD_COMMAND_DEFS } from '@core/features/board/contributions/commands';
import { CONVERSATION_COMPOSER_COMMAND_DEFS } from '@core/features/conversations/contributions/commands';
import { DEV_PERF_COMMAND_DEFS } from '@core/features/dev-perf/contributions/commands';
import { EDITOR_FILE_TREE_COMMAND_DEFS } from '@core/features/editor/contributions/commands';
import { SETTINGS_COMMAND_DEFS } from '@core/features/settings/contributions/commands';
import {
  TASK_COMMAND_DEFS,
  TASK_LIST_COMMAND_DEFS,
} from '@core/features/tasks/contributions/commands';
import { WORKBENCH_COMMAND_DEFS } from '@core/features/workbench/contributions/commands';
import { WORKFLOWS_COMMAND_DEFS } from '@core/features/workflows/contributions/commands';
import { defineCommandCatalog } from '@core/primitives/commands/api';

export const COMMAND_CATALOG = defineCommandCatalog([
  ...BOARD_COMMAND_DEFS,
  ...DEV_PERF_COMMAND_DEFS,
  ...SETTINGS_COMMAND_DEFS,
  ...EDITOR_FILE_TREE_COMMAND_DEFS,
  ...WORKBENCH_COMMAND_DEFS,
  ...TASK_COMMAND_DEFS,
  ...TASK_LIST_COMMAND_DEFS,
  ...WORKFLOWS_COMMAND_DEFS,
  ...CONVERSATION_COMPOSER_COMMAND_DEFS,
] as const);

export type CommandId = (typeof COMMAND_CATALOG.defs)[number]['id'];
