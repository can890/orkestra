import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubImportCliAccountsResponse } from '@core/primitives/github/api';
import { GITHUB_CLI_IMPORT_FAILED_MESSAGE } from './sign-in-methods';
import { SignInStep } from './sign-in-step';

const accountHooks = vi.hoisted(() => ({
  serverAvailable: undefined as boolean | undefined,
  signIn: vi.fn(async (_provider: string | undefined) => ({ success: true })),
}));

const githubHooks = vi.hoisted(() => ({
  importCliAccounts: vi.fn(
    async (): Promise<GitHubImportCliAccountsResponse> => ({
      success: true,
      importedAccountIds: [],
    })
  ),
}));

vi.mock('@core/features/account/api/browser/useAccount', () => ({
  useAccountSession: () => ({
    data: { user: null, isSignedIn: false, hasAccount: false },
    isLoading: false,
  }),
  useAccountHealth: () => ({ data: accountHooks.serverAvailable }),
  useAccountSignIn: () => ({ mutateAsync: accountHooks.signIn, isPending: false }),
}));

vi.mock('@core/features/github/api/browser/use-github-auth', () => ({
  useImportGitHubCliAccounts: () => ({
    mutateAsync: githubHooks.importCliAccounts,
    isPending: false,
  }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SignInStep', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onComplete: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    accountHooks.serverAvailable = undefined;
    accountHooks.signIn.mockClear();
    githubHooks.importCliAccounts.mockReset();
    githubHooks.importCliAccounts.mockResolvedValue({ success: true, importedAccountIds: [] });
    onComplete = vi.fn<() => void>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => {
      root.render(<SignInStep onComplete={onComplete} />);
    });
  }

  function findButton(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(label)
    );
  }

  function button(label: string): HTMLButtonElement {
    const match = findButton(label);
    if (!match) throw new Error(`no button labelled "${label}"`);
    return match;
  }

  it('makes GitHub CLI the primary action when no account server is configured', async () => {
    accountHooks.serverAvailable = false;
    await render();

    expect(findButton('Sign in with GitHub')).toBeUndefined();
    expect(button('Connect with GitHub CLI').dataset.variant).toBe('primary');
    expect(host.textContent).toContain('gh auth login');
  });

  it('does not offer account sign-in before the health check answers', async () => {
    await render();

    expect(findButton('Sign in with GitHub')).toBeUndefined();
    expect(button('Connect with GitHub CLI').dataset.variant).toBe('primary');
  });

  it('keeps account sign-in primary when the account server is available', async () => {
    accountHooks.serverAvailable = true;
    await render();

    expect(button('Sign in with GitHub').dataset.variant).toBe('primary');
    expect(button('Connect with GitHub CLI').dataset.variant).toBe('secondary');

    await act(async () => button('Sign in with GitHub').click());

    expect(accountHooks.signIn).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows GitHub CLI setup steps and retries when gh is missing or signed out', async () => {
    accountHooks.serverAvailable = false;
    await render();

    await act(async () => button('Connect with GitHub CLI').click());

    const help = host.querySelector('[role="alert"]');
    expect(help?.textContent).toContain('GitHub CLI oturumu bulunamadı');
    expect(help?.textContent).toContain('gh auth login');
    expect(help?.querySelector('a')?.getAttribute('href')).toBe('https://cli.github.com');
    expect(findButton('Connect with GitHub CLI')).toBeUndefined();
    expect(button('Tekrar dene').dataset.variant).toBe('primary');
    expect(onComplete).not.toHaveBeenCalled();

    githubHooks.importCliAccounts.mockResolvedValueOnce({
      success: true,
      importedAccountIds: ['github.com:42'],
    });
    await act(async () => button('Tekrar dene').click());

    expect(githubHooks.importCliAccounts).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps the setup steps when a retry still finds no GitHub CLI session', async () => {
    await render();

    await act(async () => button('Connect with GitHub CLI').click());
    await act(async () => button('Tekrar dene').click());

    expect(githubHooks.importCliAccounts).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'GitHub CLI oturumu bulunamadı'
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('completes the step after importing GitHub CLI accounts', async () => {
    githubHooks.importCliAccounts.mockResolvedValueOnce({
      success: true,
      importedAccountIds: ['github.com:42'],
    });
    await render();

    await act(async () => button('Connect with GitHub CLI').click());

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows an import error without the setup steps when the import fails', async () => {
    githubHooks.importCliAccounts.mockResolvedValueOnce({
      success: false,
      error: 'Failed to import GitHub CLI accounts',
    });
    await render();

    await act(async () => button('Connect with GitHub CLI').click());

    expect(host.textContent).toContain(GITHUB_CLI_IMPORT_FAILED_MESSAGE);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(findButton('Connect with GitHub CLI')).toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('lets the user skip the step', async () => {
    await render();

    await act(async () => button('Skip for now').click());

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(githubHooks.importCliAccounts).not.toHaveBeenCalled();
  });
});
