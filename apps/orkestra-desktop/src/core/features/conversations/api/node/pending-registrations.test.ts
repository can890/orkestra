import { describe, expect, it } from 'vitest';
import {
  clearConversationRegistrationPending,
  hasPendingConversationRegistrations,
  isConversationRegistrationPending,
  markConversationRegistrationPending,
} from './pending-registrations';

describe('pending conversation registrations', () => {
  it('reports a marked id until it is cleared', () => {
    markConversationRegistrationPending('c1', 1_000);
    expect(isConversationRegistrationPending('c1', 2_000)).toBe(true);
    expect(isConversationRegistrationPending('other', 2_000)).toBe(false);
    clearConversationRegistrationPending('c1');
    expect(isConversationRegistrationPending('c1', 2_000)).toBe(false);
  });

  it('expires a mark that was never claimed or compensated', () => {
    markConversationRegistrationPending('stale', 0);
    expect(isConversationRegistrationPending('stale', 60_000)).toBe(true);
    expect(isConversationRegistrationPending('stale', 2 * 60_000 + 1)).toBe(false);
    expect(isConversationRegistrationPending('stale', 0)).toBe(false);
  });

  it('reports whether any registration is still pending', () => {
    expect(hasPendingConversationRegistrations(1_000)).toBe(false);
    markConversationRegistrationPending('any', 1_000);
    expect(hasPendingConversationRegistrations(2_000)).toBe(true);
    expect(hasPendingConversationRegistrations(2 * 60_000 + 1_001)).toBe(false);
    clearConversationRegistrationPending('any');
  });
});
