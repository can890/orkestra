import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyBitbucketCredentials } from './client';
import { icon } from './icon';
import { bitbucketCredentialsSchema } from './types';

const plugin = defineIntegrationPlugin(
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    description: 'Work on Bitbucket issues',
    websiteUrl: 'https://bitbucket.org',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'email',
              label: 'Atlassian account email',
              required: false,
              placeholder: 'Atlassian account email (leave empty for an access token)',
            },
            {
              id: 'apiToken',
              label: 'API token or access token',
              secret: true,
              required: true,
              placeholder: 'API token or access token',
            },
          ],
          help: 'Bitbucket Cloud only. Enter your Atlassian account email with an API token (repository and pull request read/write, read:user:bitbucket, read:workspace:bitbucket), or leave the email empty and paste a repository, project or workspace access token.',
          helpUrl: 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    credentialsSchema: bitbucketCredentialsSchema,
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyBitbucketCredentials(credentials);
      if (!result.success) return { connected: false, error: result.error.message };
      return { connected: true, ...result.data };
    },
  },
});
