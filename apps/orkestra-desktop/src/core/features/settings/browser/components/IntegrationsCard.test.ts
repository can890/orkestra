import { integrationPluginRegistry } from '@orkestra/plugins/integrations';
import { issuesPluginRegistry } from '@orkestra/plugins/issues';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationProviderDescriptor } from '@core/features/integrations/api/contract';
import type { ProviderAccountsByProvider } from '@core/primitives/provider-accounts/api';

/**
 * Entegrasyonlar kartı, bu derlemede kayıtlı gerçek sağlayıcı tanımlarıyla (sahte hesap
 * envanteri ve sahte bağlantı işlemleriyle) çizilir: Bitbucket ve Azure DevOps listelenir,
 * bağlan akışı kurulum penceresini açar, bağlı hesap kaldırılabilir.
 */

const mocks = vi.hoisted(() => ({
  context: {} as Record<string, unknown>,
  openSetup: vi.fn(),
  confirmRemove: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@core/features/integrations/contributions/browser/integrations-provider', () => ({
  useIntegrationsContext: () => mocks.context,
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: (id: string) =>
    id === 'integrationSetupModal' ? mocks.openSetup : mocks.confirmRemove,
}));
vi.mock('@core/features/projects/api/browser/client', () => ({
  getProjectsWireClient: async () => ({ countProjectsUsingProviderAccount: async () => 0 }),
}));
vi.mock('@core/features/integrations/contributions/browser/integration-icon', () => ({
  IntegrationIcon: () => null,
}));
vi.mock('./ApplicationIntegrationsCatalog', () => ({ ApplicationIntegrationsCatalog: () => null }));
vi.mock('@orkestra/ui/react/primitives', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Trigger = ({ children, render }: { children?: React.ReactNode; render?: unknown }) =>
    (render as React.ReactElement | undefined) ??
    React.createElement(React.Fragment, null, children);
  return {
    Badge: Container,
    MicroLabel: Container,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', { type: 'button', ...props }, children),
    Sheet: {
      Root: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
        open ? React.createElement('div', { role: 'dialog' }, children) : null,
      Content: Container,
    },
    Tooltip: { Provider: Container, Root: Container, Trigger, Content: () => null },
    useToast: () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }),
  };
});

import IntegrationsCard from './IntegrationsCard';

/** Kayıtlı gerçek eklentilerden, ana sürecin gönderdiği biçimde sağlayıcı tanımları. */
const descriptors: IntegrationProviderDescriptor[] = integrationPluginRegistry
  .getAll()
  .filter((plugin) => issuesPluginRegistry.get(plugin.metadata.id))
  .map((plugin) => ({
    id: plugin.metadata.id,
    name: plugin.metadata.name,
    description: plugin.metadata.description,
    websiteUrl: plugin.metadata.websiteUrl,
    features: ['issues'],
    issueCapabilities: { requiresRepositoryUrl: false, supportsIssueContext: true },
    auth: plugin.capabilities.auth,
    icon: plugin.assets.icon,
  }));

function setContext(
  accounts: ProviderAccountsByProvider,
  integrations: IntegrationProviderDescriptor[] = descriptors
) {
  mocks.context = {
    connectionStatus: {},
    integrationAccounts: accounts,
    isLoadingAccounts: false,
    accountsError: null,
    integrations,
    integrationById: Object.fromEntries(integrations.map((item) => [item.id, item])),
    isIntegrationMutating: () => false,
    disconnectIntegration: mocks.disconnect,
    setDefaultIntegrationAccount: vi.fn(),
  };
}

describe('IntegrationsCard', () => {
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
    mocks.openSetup.mockResolvedValue({ success: true });
    mocks.confirmRemove.mockResolvedValue({ success: true });
    mocks.disconnect.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => root.render(React.createElement(IntegrationsCard)));
  }

  function cardNames(section: string): string[] {
    const element = container.querySelector(`section[aria-label="${section}"]`);
    return [...(element?.querySelectorAll('button') ?? [])].map(
      (button) => button.querySelector('span > span')?.textContent ?? ''
    );
  }

  function click(element: Element | null | undefined) {
    if (!element) throw new Error('Element not found');
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  }

  function buttonByLabel(label: string) {
    return container.querySelector(`button[aria-label="${label}"]`);
  }

  it('lists Bitbucket and Azure DevOps with the other source control providers', async () => {
    setContext({});
    await render();

    expect(cardNames('Kaynak kontrolü')).toEqual([
      'GitHub',
      'GitLab',
      'Bitbucket',
      'Azure DevOps',
      'Forgejo',
    ]);
    expect(cardNames('Görev takibi')).toEqual(
      expect.arrayContaining(['Linear', 'Jira', 'Plane', 'Trello', 'Notion'])
    );
    expect(container.querySelector('section[aria-label="Bağlı entegrasyonlar"]')).toBeNull();
    // Every registered provider is token/OAuth-connectable in this build, so none is hidden.
    expect([...cardNames('Kaynak kontrolü'), ...cardNames('Görev takibi')].sort()).toEqual(
      descriptors.map((descriptor) => descriptor.name).sort()
    );
  });

  it('opens the Bitbucket credential setup from its detail sheet', async () => {
    setContext({});
    await render();

    const bitbucket = [
      ...container.querySelectorAll('section[aria-label="Kaynak kontrolü"] button'),
    ].find((button) => button.textContent?.includes('Bitbucket'));
    await act(async () => click(bitbucket));
    await act(async () => click(buttonByLabel('Add Bitbucket account')));

    expect(mocks.openSetup).toHaveBeenCalledWith({ integration: 'bitbucket' });
  });

  it('moves a connected Azure DevOps account to the connected section and removes it', async () => {
    setContext({
      'azure-devops': [
        {
          providerId: 'azure-devops',
          accountId: 'azure-devops:acme',
          displayName: 'Ada',
          displayDetail: 'dev.azure.com/acme',
          isDefault: true,
        },
      ],
    });
    await render();

    expect(cardNames('Bağlı entegrasyonlar')).toEqual(['Azure DevOps']);
    expect(cardNames('Kaynak kontrolü')).not.toContain('Azure DevOps');

    await act(async () =>
      click(container.querySelector('section[aria-label="Bağlı entegrasyonlar"] button'))
    );
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('dev.azure.com/acme');
    await act(async () => click(buttonByLabel('Remove Ada')));

    expect(mocks.confirmRemove).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove Ada?' })
    );
    expect(mocks.disconnect).toHaveBeenCalledWith('azure-devops', 'azure-devops:acme');
  });

  it('hides providers this build cannot connect unless an account already exists', async () => {
    const unconnectable: IntegrationProviderDescriptor = {
      ...descriptors.find((item) => item.id === 'gitlab')!,
      id: 'oauth-only',
      name: 'OAuth Only',
      auth: { methods: [{ kind: 'oauth', providerId: 'oauth-only' }] },
    };
    setContext({}, [...descriptors, unconnectable]);
    await render();
    expect(container.textContent).not.toContain('OAuth Only');

    setContext(
      {
        'oauth-only': [
          { providerId: 'oauth-only', accountId: 'x', displayName: 'Legacy', isDefault: true },
        ],
      },
      [...descriptors, unconnectable]
    );
    await render();
    expect(cardNames('Bağlı entegrasyonlar')).toEqual(['OAuth Only']);
  });
});
