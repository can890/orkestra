import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

export {
  workbenchSidebarMemento,
  workbenchSidebarSchema,
  type WorkbenchSidebarState,
} from '@core/primitives/workbench-shell/api/sidebar-memento';

const workbenchPanelLayoutsV1Schema = z.object({
  version: z.literal('1'),
  layouts: z.record(z.string(), z.string()),
});

export const workbenchPanelLayoutsSchema = defineVersionedSchema()
  .initial('1', workbenchPanelLayoutsV1Schema)
  .build();
export type WorkbenchPanelLayoutsState = typeof workbenchPanelLayoutsSchema.Type;

export const workbenchPanelLayoutsMemento = defineMemento({
  id: 'workbench.panel-layouts',
  subject: appSubject,
  schema: workbenchPanelLayoutsSchema,
  default: {
    version: '1' as const,
    layouts: {},
  },
});

// The navigation and history mementos moved into the navigation primitive:
// @core/primitives/navigation/api/mementos.
