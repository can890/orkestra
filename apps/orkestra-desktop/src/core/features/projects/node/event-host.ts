import { createEventStreamHost } from '@orkestra/wire/live';
import { projectsWireContract } from '../api';

export const projectEvents = createEventStreamHost(projectsWireContract.events);
