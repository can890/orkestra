import type { ContractClient } from '@orkestra/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { conversationsContract, conversationsDomain } from '../contract';

export type ConversationsClient = ContractClient<typeof conversationsContract>;

export function getConversationsClient(): Promise<ConversationsClient> {
  return domainClient<ConversationsClient>(conversationsDomain, conversationsContract);
}
