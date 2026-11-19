import { createConversationModal } from '../browser/create-conversation-modal';
import { handoffConversationModal } from '../browser/handoff/handoff-conversation-modal';

export const conversationsBrowserContributions = {
  modalDefs: [createConversationModal, handoffConversationModal],
} as const;
