import { describe, expect, it } from 'vitest';
import {
  classifyGitHubCliImport,
  GITHUB_CLI_IMPORT_FAILED_MESSAGE,
  shouldOfferAccountSignIn,
} from './sign-in-methods';

describe('shouldOfferAccountSignIn', () => {
  it('offers account sign-in only when the account server passes its health check', () => {
    expect(shouldOfferAccountSignIn(true)).toBe(true);
  });

  it('hides account sign-in when the account server is not configured or unreachable', () => {
    expect(shouldOfferAccountSignIn(false)).toBe(false);
  });

  it('hides account sign-in until the health check has answered', () => {
    expect(shouldOfferAccountSignIn(undefined)).toBe(false);
  });
});

describe('classifyGitHubCliImport', () => {
  it('treats imported GitHub CLI accounts as connected', () => {
    expect(
      classifyGitHubCliImport({ success: true, importedAccountIds: ['github.com:42'] })
    ).toEqual({ kind: 'connected' });
  });

  it('reports a missing or signed-out gh when nothing was imported', () => {
    expect(classifyGitHubCliImport({ success: true, importedAccountIds: [] })).toEqual({
      kind: 'cli-unavailable',
    });
  });

  it('maps an import failure to a Turkish error message', () => {
    expect(
      classifyGitHubCliImport({ success: false, error: 'Failed to import GitHub CLI accounts' })
    ).toEqual({ kind: 'failed', message: GITHUB_CLI_IMPORT_FAILED_MESSAGE });
  });
});
