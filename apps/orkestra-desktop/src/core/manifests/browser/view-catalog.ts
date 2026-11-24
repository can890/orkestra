import { automationsViewDef } from '@core/features/automations/contributions/views';
import { boardViewDef } from '@core/features/board/contributions/views';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { homeViewDef } from '@core/features/workbench/contributions/views';
import { workflowsViewDef } from '@core/features/workflows/contributions/views';
import { defineViewCatalog } from '@core/primitives/views/api';

export const viewCatalog = defineViewCatalog([
  homeViewDef,
  automationsViewDef,
  boardViewDef,
  projectViewDef,
  taskViewDef,
  settingsViewDef,
  workflowsViewDef,
] as const);

export type ViewId = (typeof viewCatalog.defs)[number]['id'];
