import { createConversationModal } from '../browser/create-conversation-modal';
import { handoffConversationModal } from '../browser/handoff/handoff-conversation-modal';
import { rewindCheckpointModal } from '../browser/rewind-checkpoint-modal';

export const conversationsBrowserContributions = {
  modalDefs: [createConversationModal, rewindCheckpointModal, handoffConversationModal],
} as const;
