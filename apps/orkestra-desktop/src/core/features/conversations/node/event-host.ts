import { createEventStreamHost } from '@orkestra/wire/live';
import { conversationsContract } from '../api';

export const conversationWireEvents = createEventStreamHost(conversationsContract.events);
