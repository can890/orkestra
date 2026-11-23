import { defineContract, eventStream, fallible, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const snapshotDomain = 'snapshot' as const;

export const snapshotCaptureEventSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  appName: z.string().optional(),
  windowTitle: z.string().optional(),
  mimeType: z.literal('image/png'),
  base64: z.string(),
});
export type SnapshotCaptureEvent = z.infer<typeof snapshotCaptureEventSchema>;

export const snapshotErrorSchema = z.object({
  type: z.enum(['unsupported', 'permission_denied', 'cancelled', 'capture_failed']),
  message: z.string(),
});
export type SnapshotError = z.infer<typeof snapshotErrorSchema>;

export const snapshotStatusSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  shortcut: z.string(),
  registered: z.boolean(),
  permissionGranted: z.boolean(),
});
export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;

export const snapshotContract = defineContract({
  getStatus: procedure({ input: z.void(), output: snapshotStatusSchema }),
  captureNow: fallible({
    input: z.void(),
    data: snapshotCaptureEventSchema,
    error: snapshotErrorSchema,
  }),
  events: eventStream({ key: z.void(), event: snapshotCaptureEventSchema }),
});

export type SnapshotContract = typeof snapshotContract;
