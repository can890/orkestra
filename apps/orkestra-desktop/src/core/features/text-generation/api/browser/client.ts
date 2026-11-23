import type { ContractClient } from '@orkestra/wire/rpc';
import {
  textGenerationContract,
  textGenerationDomain,
} from '@core/features/text-generation/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type TextGenerationClient = ContractClient<typeof textGenerationContract>;

export function getTextGenerationClient(): Promise<TextGenerationClient> {
  return domainClient<TextGenerationClient>(textGenerationDomain, textGenerationContract);
}
