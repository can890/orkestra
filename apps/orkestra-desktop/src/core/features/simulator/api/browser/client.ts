import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { simulatorContract, simulatorDomain } from '../contract';

export type SimulatorClient = ContractClient<typeof simulatorContract>;

export function getSimulatorClient(): Promise<SimulatorClient> {
  return domainClient<SimulatorClient>(simulatorDomain, simulatorContract);
}
