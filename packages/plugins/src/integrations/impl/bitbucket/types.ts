import z from 'zod';
import type { VerifiedAccountIdentity } from '../../capabilities/auth';
import { credentialString, optionalCredentialString } from '../../helpers/credentials';

/**
 * İki kimlik biçimi (T3 ile aynı):
 * - e-posta (ya da Bitbucket kullanıcı adı) + API token / uygulama parolası → Basic kimlik doğrulama;
 * - yalnızca erişim anahtarı (depo, proje ya da çalışma alanı access token) → Bearer.
 */
export const bitbucketCredentialsSchema = z.object({
  email: optionalCredentialString(),
  apiToken: credentialString('A Bitbucket API token or access token is required.'),
});

export type BitbucketCredentials = z.infer<typeof bitbucketCredentialsSchema>;

export type BitbucketVerifiedConnection = {
  account?: VerifiedAccountIdentity;
  displayName?: string;
  displayDetail?: string;
  credentials: BitbucketCredentials;
};

const linkSchema = z.object({ href: z.string().optional() }).nullish();

export const bitbucketUserSchema = z.object({
  uuid: z.string().nullish(),
  account_id: z.string().nullish(),
  username: z.string().nullish(),
  nickname: z.string().nullish(),
  display_name: z.string().nullish(),
  links: z.object({ avatar: linkSchema }).nullish(),
});

export type BitbucketUser = z.infer<typeof bitbucketUserSchema>;

export const bitbucketPageSchema = z.object({
  values: z.array(z.unknown()),
  next: z.string().nullish(),
});

export const bitbucketIssueSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string().nullish(),
  kind: z.string().nullish(),
  priority: z.string().nullish(),
  content: z.object({ raw: z.string().nullish() }).nullish(),
  assignee: bitbucketUserSchema.nullish(),
  reporter: bitbucketUserSchema.nullish(),
  updated_on: z.string().nullish(),
  created_on: z.string().nullish(),
  links: z.object({ html: linkSchema }).nullish(),
  repository: z.object({ full_name: z.string().nullish(), name: z.string().nullish() }).nullish(),
});

export type BitbucketIssue = z.infer<typeof bitbucketIssueSchema>;

export const bitbucketIssueCommentSchema = z.object({
  id: z.number().int(),
  content: z.object({ raw: z.string().nullish() }).nullish(),
  user: bitbucketUserSchema.nullish(),
  created_on: z.string().nullish(),
});
