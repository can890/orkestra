import { z } from 'zod';

export type PaneLayoutNode =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; id: string; axis: 'horizontal' | 'vertical'; children: PaneLayoutNode[] };

export const paneLayoutNodeSchema: z.ZodType<PaneLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pane'), paneId: z.string().min(1) }),
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1),
      axis: z.enum(['horizontal', 'vertical']),
      children: z.array(paneLayoutNodeSchema).min(2).max(8),
    }),
  ])
);
