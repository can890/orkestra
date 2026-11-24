import { z } from 'zod';
import { defineViewScope } from '@core/primitives/view-scopes/api';
import { CONVERSATION_COMPOSER_COMMAND_DEFS } from './commands';

/** Sohbet oluşturucusu odaktayken etkin olan kapsam (zula kısayolu burada çalışır). */
export const conversationComposerScope = defineViewScope({
  id: 'conversations.composer',
  params: z.object({ conversationId: z.string().min(1) }),
  commands: CONVERSATION_COMPOSER_COMMAND_DEFS,
  activation: 'focus',
  traits: ['text-input'],
  key: ({ conversationId }) => conversationId,
});
