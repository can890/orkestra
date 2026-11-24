import { describe, expect, it } from 'vitest';
import { buildIntegrationProviderDescriptors } from './integration-payload-builder';

describe('Bitbucket and Azure DevOps provider descriptors', () => {
  it('are listed like GitLab with issues, repository scoping, auth form and icon', () => {
    const descriptors = new Map(
      buildIntegrationProviderDescriptors().map((descriptor) => [descriptor.id, descriptor])
    );
    expect(descriptors.get('gitlab')?.issueCapabilities.requiresRepositoryUrl).toBe(true);
    for (const [id, name, credentialLabel] of [
      ['bitbucket', 'Bitbucket', 'API token or access token'],
      ['azure-devops', 'Azure DevOps', 'credentials'],
    ] as const) {
      const descriptor = descriptors.get(id);
      expect(descriptor).toMatchObject({
        name,
        features: ['issues'],
        issueCapabilities: { requiresRepositoryUrl: true, supportsIssueContext: true },
        disconnectCredentialLabel: credentialLabel,
        icon: { kind: 'svg' },
      });
      expect(descriptor?.auth.methods[0]?.kind).toBe('form');
    }
  });
});
