import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Yalnızca depo kapsamlı bir görev sağlayıcısına (ör. Bitbucket) bağlı bir projede boş görev
 * listesindeki "Create from Issue" eylemi, ayarlara yönlendirmek yerine görev seçiciyi açmalı.
 */

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, unknown>,
  openTaskModal: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@core/features/integrations/contributions/browser/integrations-provider', () => ({
  useIntegrationsContext: () => ({
    integrations: [
      {
        id: 'bitbucket',
        features: ['issues'],
        issueCapabilities: { requiresRepositoryUrl: true, supportsIssueContext: true },
      },
    ],
    integrationAccounts: {
      bitbucket: [
        {
          providerId: 'bitbucket',
          accountId: 'bitbucket:ada',
          displayName: 'Ada',
          isDefault: true,
        },
      ],
    },
    isLoadingAccounts: false,
    accountsError: null,
  }),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectSettingsStore: () => undefined,
}));
vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: () => mocks.repository,
}));
vi.mock('@core/features/projects/contributions/browser/project-availability-ui', () => ({
  projectAvailabilityUiContribution: {
    getLiveActionDisabledReason: () => undefined,
    defaultLiveActionDisabledReason: 'Unavailable',
  },
}));
vi.mock('@core/features/settings/contributions/views', () => ({
  settingsViewDef: (params: unknown) => ({ view: 'settings', params }),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  taskHostActionAvailability: () => ({ kind: 'enabled' }),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.openTaskModal,
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));
vi.mock('@core/primitives/keybindings/browser/shortcut', () => ({ Shortcut: () => null }));
vi.mock('@core/primitives/react-hooks/browser/use-arrow-key-navigation', () => ({
  useArrowKeyNavigation: () => ({ selectedIndex: -1, setSelectedIndex: vi.fn() }),
}));

import { TaskListEmptyState } from './task-list-empty-state';

describe('TaskListEmptyState issue action', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    container = dom.window.document.getElementById('root')!;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function clickCreateFromIssue() {
    await act(async () =>
      root.render(React.createElement(TaskListEmptyState, { projectId: 'project-1' }))
    );
    const button = container.querySelector('button[aria-label="Create from Issue"]');
    expect(button?.textContent).toContain('Link and create a task from an issue');
    await act(async () => {
      button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  }

  it('opens the issue picker for a Bitbucket remote connected through Bitbucket alone', async () => {
    mocks.repository = {
      canonicalRepositoryUrl: 'https://bitbucket.org/acme/web',
      issueRepositoryUrl: null,
      pullRequestRepositoryUrl: null,
      providerRepository: null,
    };

    await clickCreateFromIssue();

    expect(mocks.openTaskModal).toHaveBeenCalledWith({
      projectId: 'project-1',
      strategy: 'from-issue',
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('still points to the integration settings when the project has no remote', async () => {
    mocks.repository = {
      canonicalRepositoryUrl: null,
      issueRepositoryUrl: null,
      pullRequestRepositoryUrl: null,
      providerRepository: null,
    };
    await act(async () =>
      root.render(React.createElement(TaskListEmptyState, { projectId: 'project-1' }))
    );
    const button = container.querySelector('button[aria-label="Create from Issue"]');
    expect(button?.textContent).toContain('Configure issue integrations');
    await act(async () => {
      button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.openTaskModal).not.toHaveBeenCalled();
  });
});
