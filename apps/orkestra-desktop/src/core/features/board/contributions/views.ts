import { z } from 'zod';
import { workbenchLayout } from '@core/primitives/layouts/api';
import { defineView } from '@core/primitives/views/api';

export const boardViewDef = defineView({
  id: 'board',
  params: z.object({}),
  layout: workbenchLayout,
  // The telemetry event union is closed, so the Board has no view event. Omitting the option
  // would widen the inferred event type to `string` and break the telemetry call sites;
  // `never` keeps the union intact and the runtime value stays undefined.
  telemetryEvent: undefined as never,
});
