import type { ContractClient } from '@orkestra/wire/rpc';
import { acpRegistryContract, acpRegistryDomain } from '@core/features/acp-registry/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type AcpRegistryRpcClient = ContractClient<typeof acpRegistryContract>;

export function getAcpRegistryClient(): Promise<AcpRegistryRpcClient> {
  return domainClient<AcpRegistryRpcClient>(acpRegistryDomain, acpRegistryContract);
}

export function unwrapAcp<T>(
  result: { success: true; data: T } | { success: false; error: { message: string } }
): T {
  if (result.success) return result.data;
  throw new Error(result.error.message);
}

export const ACP_REGISTRY_QUERY_KEY = ['acp-registry'] as const;
