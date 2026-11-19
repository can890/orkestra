import { createConversationModal } from '../browser/create-conversation-modal';
import { rewindCheckpointModal } from '../browser/rewind-checkpoint-modal';

export const conversationsBrowserContributions = {
  modalDefs: [createConversationModal, rewindCheckpointModal],
} as const;
