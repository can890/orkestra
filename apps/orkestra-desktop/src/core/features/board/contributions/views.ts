import { z } from 'zod';
import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';

export const boardViewDef = defineView({
  id: 'board',
  params: z.object({}),
  layout: workbenchLayout,
  telemetryEvent: 'board_viewed',
});
