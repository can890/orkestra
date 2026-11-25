import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

// Kenar çubuğu durumu (genişletilmiş projeler, sıralama, bölüm açık/kapalı, ertelenen görevler).
// Hem workbench özelliği hem de mementos servisi (telefonla paylaşılan erteleme işlemleri) okur;
// bu yüzden ikisinin de içe aktarabildiği workbench-shell primitive'inde durur.
const workbenchSidebarV1Schema = z.object({
  version: z.literal('1'),
  expandedProjectIds: z.array(z.string()),
  projectOrder: z.array(z.string()),
  taskOrderByProject: z.record(z.string(), z.array(z.string())),
  taskSortBy: z.enum(['created-at', 'updated-at']),
  // Open/closed state of the collapsible sidebar sections. Optional (absent = the section's
  // default) so rows written before it existed stay valid v1 rows and older builds that read a
  // newer row simply ignore it instead of falling back to the whole default sidebar state.
  sectionOpen: z
    .object({
      freeChats: z.boolean().optional(),
      externalSessions: z.boolean().optional(),
      settled: z.boolean().optional(),
      snoozed: z.boolean().optional(),
      waiting: z.boolean().optional(),
    })
    .optional(),
  snoozedTasks: z
    .record(
      z.string(),
      z.object({
        projectId: z.string(),
        since: z.number().int(),
        until: z.number().int().positive(),
      })
    )
    .optional(),
});

export const workbenchSidebarSchema = defineVersionedSchema()
  .initial('1', workbenchSidebarV1Schema)
  .build();

export type WorkbenchSidebarState = typeof workbenchSidebarSchema.Type;

export const workbenchSidebarMemento = defineMemento({
  id: 'workbench.sidebar',
  subject: appSubject,
  schema: workbenchSidebarSchema,
  default: {
    version: '1' as const,
    expandedProjectIds: [],
    projectOrder: [],
    taskOrderByProject: {},
    taskSortBy: 'created-at' as const,
  },
});
