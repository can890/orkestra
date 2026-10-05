import { createEventStreamHost } from '@orkestra/wire/live';
import { browserContract } from '../api';

let hasSubscribers = false;

export const browserEvents = createEventStreamHost(browserContract.events, {
  onActive: () => {
    hasSubscribers = true;
  },
  onIdle: () => {
    hasSubscribers = false;
  },
});

/**
 * True while a renderer listens to browser events. Agent tab requests are answered by the
 * renderer, so main rejects them immediately when nobody is listening.
 */
export function hasBrowserEventSubscribers(): boolean {
  return hasSubscribers;
}
