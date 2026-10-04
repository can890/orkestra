import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountAuthServerClient } from './account-auth-server-client';
import { AccountOAuthClient } from './account-oauth-client';

vi.mock('../config', () => ({
  ACCOUNT_CONFIG: { authServer: { baseUrl: '', authTimeoutMs: 5000 } },
}));

afterEach(() => vi.unstubAllGlobals());

describe('Orkestra without an account server', () => {
  it('does not open OAuth or transmit session credentials', async () => {
    const execute = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const oauth = new AccountOAuthClient(execute);
    const server = new AccountAuthServerClient();
    expect((await oauth.signIn('github')).success).toBe(false);
    expect((await oauth.linkProviderAccount('github', 'test-link-state')).success).toBe(false);
    expect(await server.validateSession('test-session')).toEqual({ success: true, data: 'unknown' });
    expect((await server.startAccountLink('test-session')).success).toBe(false);
    expect(await server.checkHealth()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
