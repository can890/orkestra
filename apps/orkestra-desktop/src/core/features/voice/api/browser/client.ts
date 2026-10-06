import type { ContractClient } from '@orkestra/wire/rpc';
import { voiceContract, voiceDomain } from '@core/features/voice/api/contract';
import { domainClient } from '@core/primitives/wire/browser/connection';

export type VoiceClient = ContractClient<typeof voiceContract>;

export function getVoiceClient(): Promise<VoiceClient> {
  return domainClient<VoiceClient>(voiceDomain, voiceContract);
}
