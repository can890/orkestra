import { describe, expect, it } from 'vitest';
import { createFakeFetch } from '../../helpers/fake-fetch.testing';
import { azureDevOpsAuthorization, verifyAzureDevOpsCredentials } from './client';

const ORG = 'https://dev.azure.com/acme';

describe('Azure DevOps auth header', () => {
  it('sends the PAT as Basic auth with an empty user name', () => {
    expect(azureDevOpsAuthorization({ organizationUrl: ORG, personalAccessToken: 'pat' })).toEqual({
      success: true,
      data: `Basic ${Buffer.from(':pat').toString('base64')}`,
    });
  });
});

describe('verifyAzureDevOpsCredentials', () => {
  it('returns the identity scoped to the organization', async () => {
    const fake = createFakeFetch([
      {
        match: '/acme/_apis/connectionData',
        body: {
          authenticatedUser: {
            id: '6a8b-guid',
            providerDisplayName: 'Ada Lovelace',
            properties: { Account: { $type: 'System.String', $value: 'ada@example.com' } },
          },
          instanceId: 'x',
        },
      },
      { match: '/acme/_apis/projects', body: { count: 1, value: [{ id: 'p1', name: 'Web' }] } },
    ]);
    const result = await verifyAzureDevOpsCredentials(
      { organizationUrl: 'https://acme.visualstudio.com/', personalAccessToken: ' pat ' },
      { fetch: fake.fetch }
    );
    expect(result).toEqual({
      success: true,
      data: {
        account: {
          id: '6a8b-guid',
          login: 'ada@example.com',
          host: 'dev.azure.com',
          scope: ORG,
        },
        displayName: 'Ada Lovelace',
        displayDetail: 'dev.azure.com/acme',
        credentials: { organizationUrl: ORG, personalAccessToken: 'pat' },
      },
    });
    for (const call of fake.calls) {
      expect(call.headers.authorization).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
      expect(call.headers['x-tfs-fedauthredirect']).toBe('Suppress');
    }
    expect(
      fake.calls.find((call) => call.url.pathname.endsWith('/projects'))?.url.search
    ).toContain('api-version=7.1');
  });

  it('treats the sign-in page Azure returns for a bad PAT as an auth failure', async () => {
    const fake = createFakeFetch([
      { match: '/acme/_apis/', status: 203, text: '<!DOCTYPE html><html>Sign In</html>' },
    ]);
    expect(
      await verifyAzureDevOpsCredentials(
        { organizationUrl: ORG, personalAccessToken: 'bad' },
        { fetch: fake.fetch }
      )
    ).toMatchObject({ success: false, error: { type: 'auth_failed' } });
  });

  it('fails when the PAT cannot read the organization', async () => {
    const fake = createFakeFetch([
      { match: '/acme/_apis/connectionData', body: { authenticatedUser: { id: 'x' } } },
      { match: '/acme/_apis/projects', status: 401, body: {} },
    ]);
    expect(
      await verifyAzureDevOpsCredentials(
        { organizationUrl: ORG, personalAccessToken: 'pat' },
        { fetch: fake.fetch }
      )
    ).toMatchObject({ success: false, error: { type: 'auth_failed' } });
  });

  it('rejects on-premises servers before any request', async () => {
    const fake = createFakeFetch([]);
    expect(
      await verifyAzureDevOpsCredentials(
        { organizationUrl: 'https://tfs.example.com/tfs/Default', personalAccessToken: 'pat' },
        { fetch: fake.fetch }
      )
    ).toMatchObject({ success: false, error: { type: 'invalid_input' } });
    expect(fake.calls).toHaveLength(0);
  });
});
