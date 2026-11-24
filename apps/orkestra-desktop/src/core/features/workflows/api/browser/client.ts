import { getConversationsClient } from '@core/features/conversations/api/browser/client';

/** Kod iş akışı prosedürleri konuşmalar sözleşmesinin `codeWorkflows` alt sözleşmesindedir. */
export async function getCodeWorkflowsClient() {
  return (await getConversationsClient()).codeWorkflows;
}
