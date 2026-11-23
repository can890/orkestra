import { z } from 'zod';
import type { SnapshotSettings } from '@core/primitives/app-settings/api';
import { defineSettingsContribution } from '@core/primitives/settings/api';

const snapshotSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  shortcut: z.string().default('CommandOrControl+Shift+9'),
  captureMode: z.enum(['active-window', 'interactive']).default('active-window'),
  includeWindowMetadata: z.boolean().default(true),
});

export const snapshotSettingsContribution = defineSettingsContribution<'snapshot', SnapshotSettings>(
  {
    key: 'snapshot',
    schema: snapshotSettingsSchema,
    defaults: {
      enabled: false,
      shortcut: 'CommandOrControl+Shift+9',
      captureMode: 'active-window',
      includeWindowMetadata: true,
    },
  }
);
