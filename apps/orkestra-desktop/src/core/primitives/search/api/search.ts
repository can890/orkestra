import { portableRelativePathSchema, resourceUriSchema } from '@orkestra/core/primitives/path/api';
import { z } from 'zod';

export type PaletteEntityKind = 'task' | 'project' | 'conversation';

export interface SearchItem {
  kind: PaletteEntityKind;
  id: string;
  projectId: string | null;
  taskId: string | null;
  title: string;
  subtitle: string;
  score: number;
}

export interface PaletteEntitySearchQuery {
  kind: PaletteEntityKind;
  query: string;
  context?: {
    projectId?: string;
    taskId?: string;
    workspaceId?: string;
  };
  limit?: number;
}

export const workspaceFileSearchQuerySchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string(),
  limit: z.number().optional(),
});

export type WorkspaceFileSearchQuery = z.infer<typeof workspaceFileSearchQuerySchema>;

export const workspaceFileHitSchema = z.object({
  resource: resourceUriSchema,
  relativePath: portableRelativePathSchema,
  filename: z.string(),
});

export type WorkspaceFileHit = z.infer<typeof workspaceFileHitSchema>;

export const messageSearchQuerySchema = z.object({
  query: z.string(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  limit: z.number().optional(),
});

export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;

export const messageSearchHitSchema = z.object({
  conversationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  itemId: z.string(),
  role: z.string(),
  conversationTitle: z.string(),
  snippet: z.string(),
  score: z.number(),
});

export type MessageSearchHit = z.infer<typeof messageSearchHitSchema>;

export const indexConversationMessageSchema = z.object({
  itemId: z.string(),
  role: z.string(),
  content: z.string(),
  createdAt: z.number().optional(),
});

export const indexConversationMessagesInputSchema = z.object({
  conversationId: z.string().min(1),
  projectId: z.string(),
  taskId: z.string(),
  conversationTitle: z.string(),
  messages: z.array(indexConversationMessageSchema),
});

export type IndexConversationMessagesInput = z.infer<typeof indexConversationMessagesInputSchema>;
