import { describe, expect, it } from 'vitest';
import type { IntegrationProviderDescriptor } from '@core/features/integrations/api/contract';
import { visibleGitHubConnectMethods } from './github-connect-methods';

type AuthMethod = IntegrationProviderDescriptor['auth']['methods'][number];

const methods = (clientId = ''): AuthMethod[] => [
  { kind: 'oauth', providerId: 'github' },
  { kind: 'oauth-device', clientId, scopes: ['repo'] },
  { kind: 'cli-import', cli: 'gh' },
];

describe('visibleGitHubConnectMethods', () => {
  it('offers only GitHub CLI when there is no account server and no OAuth client id', () => {
    expect(
      visibleGitHubConnectMethods({
        methods: methods(),
        accountServerAvailable: false,
        hasAccount: false,
      })
    ).toEqual({ cli: true, oauth: false, deviceFlow: false });
  });

  it('hides the account sign-in until the server health check has passed', () => {
    expect(
      visibleGitHubConnectMethods({
        methods: methods(),
        accountServerAvailable: undefined,
        hasAccount: false,
      }).oauth
    ).toBe(false);
    expect(
      visibleGitHubConnectMethods({
        methods: methods(),
        accountServerAvailable: true,
        hasAccount: false,
      }).oauth
    ).toBe(true);
  });

  it('offers the device flow only with a client id and without an Orkestra account', () => {
    expect(
      visibleGitHubConnectMethods({
        methods: methods('Iv1.abc'),
        accountServerAvailable: false,
        hasAccount: false,
      }).deviceFlow
    ).toBe(true);
    expect(
      visibleGitHubConnectMethods({
        methods: methods('Iv1.abc'),
        accountServerAvailable: true,
        hasAccount: true,
      }).deviceFlow
    ).toBe(false);
  });
});
