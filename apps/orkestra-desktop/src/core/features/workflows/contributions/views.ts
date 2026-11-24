import { z } from 'zod';
import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';

export const workflowsViewDef = defineView({
  id: 'workflows',
  params: z.object({
    runId: z.string().optional(),
  }),
  layout: workbenchLayout,
  telemetryEvent: 'workflows_viewed',
});
