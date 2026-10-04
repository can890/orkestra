import { z } from 'zod';
export const mcpConnectionStateSchema = z.object({
  id: z.string(),
  phase: z.enum([
    'starting',
    'awaiting-authorization',
    'saving',
    'connected',
    'failed',
    'cancelled',
  ]),
  url: z.url().optional(),
  message: z.string(),
});
export type McpConnectionState = z.infer<typeof mcpConnectionStateSchema>;
