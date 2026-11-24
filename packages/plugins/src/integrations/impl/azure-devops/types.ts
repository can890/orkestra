import z from 'zod';
import type { VerifiedAccountIdentity } from '../../capabilities/auth';
import { credentialString } from '../../helpers/credentials';
import { normalizeAzureDevOpsOrganizationUrl } from './remote';

export const azureDevOpsCredentialsSchema = z.object({
  organizationUrl: credentialString('An Azure DevOps organization is required.')
    .transform((value) => normalizeAzureDevOpsOrganizationUrl(value))
    .pipe(
      z.string(
        'Enter an Azure DevOps organization such as https://dev.azure.com/your-organization.'
      )
    ),
  personalAccessToken: credentialString('An Azure DevOps personal access token is required.'),
});

export type AzureDevOpsCredentials = z.infer<typeof azureDevOpsCredentialsSchema>;

export type AzureDevOpsVerifiedConnection = {
  account?: VerifiedAccountIdentity;
  displayName?: string;
  displayDetail?: string;
  credentials: AzureDevOpsCredentials;
};

export const azureDevOpsConnectionDataSchema = z.object({
  authenticatedUser: z
    .object({
      id: z.string().nullish(),
      providerDisplayName: z.string().nullish(),
      customDisplayName: z.string().nullish(),
      properties: z
        .object({ Account: z.object({ $value: z.string().nullish() }).nullish() })
        .nullish(),
    })
    .nullish(),
});

const identityObjectSchema = z.object({
  displayName: z.string().nullish(),
  uniqueName: z.string().nullish(),
  imageUrl: z.string().nullish(),
});

/** WIQL kimliği nesne olarak döndürür; bir proje kuralı düz "Ad <e-posta>" dizesi bırakabilir. */
export const azureDevOpsIdentityValueSchema = z.union([identityObjectSchema, z.string()]).nullish();

export type AzureDevOpsIdentityValue = z.infer<typeof azureDevOpsIdentityValueSchema>;

export const azureDevOpsWorkItemSchema = z.object({
  id: z.number().int(),
  url: z.string().nullish(),
  fields: z
    .object({
      'System.Title': z.string().nullish(),
      'System.State': z.string().nullish(),
      'System.WorkItemType': z.string().nullish(),
      'System.TeamProject': z.string().nullish(),
      'System.ChangedDate': z.string().nullish(),
      'System.CreatedDate': z.string().nullish(),
      'System.Description': z.string().nullish(),
      'Microsoft.VSTS.TCM.ReproSteps': z.string().nullish(),
      'System.Tags': z.string().nullish(),
      'System.AssignedTo': azureDevOpsIdentityValueSchema,
      'System.CreatedBy': azureDevOpsIdentityValueSchema,
    })
    .nullish(),
  _links: z.object({ html: z.object({ href: z.string().nullish() }).nullish() }).nullish(),
});

export type AzureDevOpsWorkItem = z.infer<typeof azureDevOpsWorkItemSchema>;
