import { createEventStreamHost } from '@orkestra/wire/live';
import { browserContract } from '../api';

export const browserEvents = createEventStreamHost(browserContract.events);
