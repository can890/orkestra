import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyAzureDevOpsCredentials } from './client';
import { icon } from './icon';
import { azureDevOpsCredentialsSchema } from './types';

const plugin = defineIntegrationPlugin(
  {
    id: 'azure-devops',
    name: 'Azure DevOps',
    description: 'Work on Azure Boards work items',
    websiteUrl: 'https://dev.azure.com',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'organizationUrl',
              label: 'Organization URL',
              required: true,
              placeholder: 'https://dev.azure.com/your-organization',
            },
            {
              id: 'personalAccessToken',
              label: 'Personal access token',
              secret: true,
              required: true,
              placeholder: 'Personal access token',
            },
          ],
          help: 'Azure DevOps Services only. Create a personal access token for this organization with Work Items (Read) and Code (Read & write) scopes.',
          helpUrl:
            'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    credentialsSchema: azureDevOpsCredentialsSchema,
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyAzureDevOpsCredentials(credentials);
      if (!result.success) return { connected: false, error: result.error.message };
      return { connected: true, ...result.data };
    },
  },
});
