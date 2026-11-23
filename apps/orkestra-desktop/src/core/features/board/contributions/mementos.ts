import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import type { BoardLayoutNode } from '@core/features/board/api/board-layout';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

const boardTileNodeSchema = z.object({
  kind: z.literal('tile'),
  projectId: z.string(),
  taskId: z.string(),
});

const boardLayoutNodeSchema: z.ZodType<BoardLayoutNode> = z.lazy(() =>
  z.union([
    boardTileNodeSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string(),
      axis: z.enum(['horizontal', 'vertical']),
      children: z.array(boardLayoutNodeSchema),
    }),
  ])
);

const boardLayoutV1Schema = z.object({
  version: z.literal('1'),
  tiles: z.array(z.object({ projectId: z.string(), taskId: z.string() })),
  layout: boardLayoutNodeSchema.optional(),
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
