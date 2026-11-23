import type { ContractClient } from '@orkestra/wire/rpc';
import { secretsContract, secretsDomain } from '@core/features/secrets/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type SecretsClient = ContractClient<typeof secretsContract>;

export function getSecretsClient(): Promise<SecretsClient> {
  return domainClient<SecretsClient>(secretsDomain, secretsContract);
}
