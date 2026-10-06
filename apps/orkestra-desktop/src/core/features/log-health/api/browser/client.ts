import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { logHealthContract, logHealthDomain } from '../contract';

export type LogHealthClient = ContractClient<typeof logHealthContract>;

export function getLogHealthClient(): Promise<LogHealthClient> {
  return domainClient<LogHealthClient>(logHealthDomain, logHealthContract);
}
