import { describe, expect, it } from 'vitest';
import {
  isDefaultConversationTitle,
  parseDefaultConversationTitleIndex,
} from './default-conversation-title';

describe('default conversation titles', () => {
  it('parses "<provider> (<n>)" case-insensitively', () => {
    expect(parseDefaultConversationTitleIndex('Claude (1)', 'claude')).toBe(1);
    expect(parseDefaultConversationTitleIndex('antigravity (12)', 'antigravity')).toBe(12);
    expect(parseDefaultConversationTitleIndex('Claude (01)', 'claude')).toBeNull();
    expect(parseDefaultConversationTitleIndex('Claude (0)', 'claude')).toBeNull();
    expect(parseDefaultConversationTitleIndex('Claude', 'claude')).toBeNull();
    expect(parseDefaultConversationTitleIndex('Codex (1)', 'claude')).toBeNull();
  });

  it('escapes provider ids used in the pattern', () => {
    expect(parseDefaultConversationTitleIndex('my.agent (2)', 'my.agent')).toBe(2);
    expect(parseDefaultConversationTitleIndex('myXagent (2)', 'my.agent')).toBeNull();
  });

  it('checks a title against several providers and ignores empty ids', () => {
    expect(isDefaultConversationTitle('Antigravity (1)', [null, 'claude', 'antigravity'])).toBe(
      true
    );
    expect(isDefaultConversationTitle('Nano banana ile kedi görseli', ['claude'])).toBe(false);
    expect(isDefaultConversationTitle(null, ['claude'])).toBe(false);
  });
});
