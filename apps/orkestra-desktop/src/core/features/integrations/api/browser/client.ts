import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { integrationsContract, integrationsDomain } from '../contract';

export type IntegrationsClient = ContractClient<typeof integrationsContract>;

export function getIntegrationsClient(): Promise<IntegrationsClient> {
  return domainClient<IntegrationsClient>(integrationsDomain, integrationsContract);
}
