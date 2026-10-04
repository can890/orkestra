import { createEventStreamHost } from '@orkestra/wire/live';
import { githubContract } from '../api';

export const githubEvents = createEventStreamHost(githubContract.events);
