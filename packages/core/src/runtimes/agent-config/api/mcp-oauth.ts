import { z } from 'zod';
export const mcpOAuthGrantSchema = z
  .object({
    server_name: z.string().regex(/^[\w.-]+$/),
    server_url: z.url().refine((value) => new URL(value).protocol === 'https:'),
    issuer: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:')
      .optional(),
    google_workspace: z
      .object({
        tool: z.enum([
          'gmail',
          'drive',
          'calendar',
          'docs',
          'sheets',
          'slides',
          'forms',
          'tasks',
          'chat',
        ]),
        email: z.email().regex(/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/),
        client_secret: z.string().min(1),
      })
      .optional(),
    client_id: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_at: z.number().nullable().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .refine(
    (grant) =>
      !grant.google_workspace ||
      (grant.server_name === 'google_' + grant.google_workspace.tool &&
        grant.server_url === 'https://www.googleapis.com/' &&
        grant.client_id.endsWith('.apps.googleusercontent.com') &&
        !!grant.refresh_token),
    'Google bağlantısı doğrulanamadı.'
  );
export const installMcpOAuthInputSchema = z.object({
  grant: mcpOAuthGrantSchema,
  providers: z.array(z.string()).min(1),
});
export type InstallMcpOAuthInput = z.infer<typeof installMcpOAuthInputSchema>;
