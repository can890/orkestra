import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

const boardLayoutV1Schema = z.object({
  version: z.literal('1'),
  tiles: z.array(z.object({ projectId: z.string(), taskId: z.string() })),
});

export const boardLayoutSchema = defineVersionedSchema().initial('1', boardLayoutV1Schema).build();

export type BoardLayoutState = typeof boardLayoutSchema.Type;

export const boardLayoutMemento = defineMemento({
  id: 'board.layout',
  subject: appSubject,
  schema: boardLayoutSchema,
  default: {
    version: '1' as const,
    tiles: [],
  },
});
