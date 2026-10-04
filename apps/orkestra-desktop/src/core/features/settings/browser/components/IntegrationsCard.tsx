import type { PluginIconAsset } from '@orkestra/shared/plugins';
import { Button, Sheet, Tooltip } from '@orkestra/ui/react/primitives';
import { Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { isIssueIntegration } from '@core/features/integrations/api/browser/integration-display';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { supportsIntegrationReconnect } from '@core/manifests/browser/integration-auth-contributions';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { ConnectionStatus, IssueProviderType } from '@core/primitives/issue-providers/api';
import { ApplicationIntegrationsCatalog } from './ApplicationIntegrationsCatalog';
import { IntegrationDetailSidebar } from './IntegrationDetailSidebar';
import { IntegrationGridCard } from './IntegrationGridCard';

export type IntegrationItem = {
  id: IssueProviderType;
  name: string;
  description: string;
  icon: PluginIconAsset;
  features: string[];
  isConfigured: boolean;
  isConfigurationKnown: boolean;
  isMutating: boolean;
  connectionError?: string;
  displayName?: string;
  displayDetail?: string;
  canReconnect: boolean;
  onConnect: () => void;
};

const IntegrationsCard: React.FC = () => {
  const {
    connectionStatus,
    integrationAccounts,
    isLoadingAccounts,
    accountsError,
    integrations: integrationMetadata,
    isIntegrationMutating,
  } = useIntegrationsContext();
  const [selectedProvider, setSelectedProvider] = useState<IssueProviderType | null>(null);
  const [addingIntegration, setAddingIntegration] = useState(false);
  const openIntegrationSetup = useOpenModal('integrationSetupModal');

  const integrations: IntegrationItem[] = integrationMetadata
    .filter(isIssueIntegration)
    .map((integration) => {
      const provider = integration.id;
      const status: ConnectionStatus = connectionStatus[provider] ?? {
        connected: false,
        capabilities: integration.issueCapabilities,
      };
      const isConfigured = (integrationAccounts[provider]?.length ?? 0) > 0;
      const isConfigurationKnown = !isLoadingAccounts && !accountsError;

      return {
        id: provider,
        name: integration.name,
        description: integration.description,
        icon: integration.icon,
        features: integration.features,
        isConfigured,
        isConfigurationKnown,
        isMutating: isIntegrationMutating(provider),
        connectionError: isConfigured ? status.error : undefined,
        displayName:
          integrationAccounts[provider]?.find((account) => account.isDefault)?.displayName ??
          status.displayName,
        displayDetail: status.displayDetail,
        canReconnect: supportsIntegrationReconnect(integration),
        onConnect: () => void openIntegrationSetup({ integration: provider }),
      };
    });

  const connectedIntegrations = integrations.filter((integration) => integration.isConfigured);
  const availableIntegrations = integrations.filter(
    (integration) => integration.id === 'github' && !integration.isConfigured
  );
  const selectedIntegration = selectedProvider
    ? (integrations.find((integration) => integration.id === selectedProvider) ?? null)
    : null;

  function closeSheet() {
    setSelectedProvider(null);
  }

  return (
    <Tooltip.Provider delay={150}>
      <div className="space-y-8">
        {accountsError ? (
          <p role="alert" className="text-sm text-foreground-error">
            Hesaplar yüklenemedi. Lütfen yeniden deneyin.
          </p>
        ) : null}
        {connectedIntegrations.length > 0 && (
          <IntegrationSection title="Bağlı entegrasyonlar">
            {connectedIntegrations.map((integration) => (
              <IntegrationGridCard
                key={integration.id}
                integration={integration}
                selected={integration.id === selectedProvider}
                onSelect={() => setSelectedProvider(integration.id)}
              />
            ))}
          </IntegrationSection>
        )}

        {availableIntegrations.length > 0 && (
          <IntegrationSection title="GitHub">
            {availableIntegrations.map((integration) => (
              <IntegrationGridCard
                key={integration.id}
                integration={integration}
                selected={integration.id === selectedProvider}
                onSelect={() => setSelectedProvider(integration.id)}
              />
            ))}
          </IntegrationSection>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-foreground-muted">
            Uygulama bağlantılarını Claude, Codex ve diğer ajanlarınıza ekleyin.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setAddingIntegration((current) => !current);
            }}
          >
            {addingIntegration ? <X className="size-4" /> : <Plus className="size-4" />}
            {addingIntegration ? 'Vazgeç' : 'Entegrasyon ekle'}
          </Button>
        </div>
        {addingIntegration && (
          <section
            aria-label="Entegrasyon ekle"
            className="space-y-4 rounded-lg border border-border p-4"
          >
            <ApplicationIntegrationsCatalog />
          </section>
        )}
      </div>

      <Sheet.Root
        open={selectedIntegration !== null}
        onOpenChange={(open) => !open && closeSheet()}
      >
        <Sheet.Content className="[-webkit-app-region:no-drag]">
          {selectedIntegration && (
            <IntegrationDetailSidebar integration={selectedIntegration} onClose={closeSheet} />
          )}
        </Sheet.Content>
      </Sheet.Root>
    </Tooltip.Provider>
  );
};

function IntegrationSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-normal text-foreground">{title}</h3>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
      >
        {children}
      </div>
    </section>
  );
}

export default IntegrationsCard;
