import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { hostMaintenanceContract, hostMaintenanceDomain } from './maintenance-contract';

export type HostMaintenanceClient = ContractClient<typeof hostMaintenanceContract>;

export function getHostMaintenanceClient(): Promise<HostMaintenanceClient> {
  return domainClient<HostMaintenanceClient>(hostMaintenanceDomain, hostMaintenanceContract);
}
