import { getConversationsClient } from '@core/features/conversations/api/browser/client';

/** İş akışı prosedürleri konuşmalar sözleşmesinin `workflows` alt sözleşmesindedir. */
export async function getWorkflowsClient() {
  return (await getConversationsClient()).workflows;
}
