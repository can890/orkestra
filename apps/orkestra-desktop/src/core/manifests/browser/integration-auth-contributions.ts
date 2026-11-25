import { githubIntegrationAuth } from '@core/features/github/contributions/integration-auth';
import type { IntegrationAuthUiContribution } from '@core/features/integrations/api/browser/integration-auth-ui';
import type { IntegrationProviderDescriptor } from '@core/features/integrations/api/contract';

const integrationAuthContributions: IntegrationAuthUiContribution[] = [githubIntegrationAuth];

export function getIntegrationAuthUi(metadata: Pick<IntegrationProviderDescriptor, 'id' | 'auth'>) {
  return integrationAuthContributions.find(
    (contribution) =>
      contribution.integrationId === metadata.id &&
      metadata.auth.methods.some((method) => contribution.methodKinds.includes(method.kind))
  );
}

/**
 * Whether the shared setup modal can connect a new account: either the generic credential form
 * renders it, or a provider-owned auth UI is registered for one of its methods. Integrations
 * without either (e.g. only an OAuth app this build has no client for) cannot be connected.
 */
export function canConnectIntegration(
  metadata: Pick<IntegrationProviderDescriptor, 'id' | 'auth'>
): boolean {
  return (
    metadata.auth.methods.some((method) => method.kind === 'form') ||
    getIntegrationAuthUi(metadata) !== undefined
  );
}

export function supportsIntegrationReconnect(
  metadata: Pick<IntegrationProviderDescriptor, 'id' | 'auth'>
): boolean {
  return (
    metadata.auth.methods.some((method) => method.kind === 'form') ||
    getIntegrationAuthUi(metadata)?.supportsReconnect === true
  );
}
