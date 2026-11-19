import { describe, expect, it } from 'vitest';
import {
  buildDeepLink,
  DEEP_LINK_MAX_LENGTH,
  extractDeepLinkFromArgv,
  parseDeepLink,
} from './deep-link';

const UUID = '3f2b8c1e-9a4d-4e57-8b1a-2c6d7e8f9a0b';

describe('parseDeepLink', () => {
  it.each([
    ['orkestra://task/' + UUID, { kind: 'task', id: UUID }],
    ['orkestra://project/' + UUID, { kind: 'project', id: UUID }],
    ['orkestra://conversation/' + UUID, { kind: 'conversation', id: UUID }],
    [
      'orkestra://conversation/claude-chat-abc_1-1700000000000',
      { kind: 'conversation', id: 'claude-chat-abc_1-1700000000000' },
    ],
    ['orkestra://task/' + UUID + '/', { kind: 'task', id: UUID }],
    ['ORKESTRA://task/' + UUID, { kind: 'task', id: UUID }],
    ['Orkestra://task/abc', { kind: 'task', id: 'abc' }],
  ])('%s', (input, expected) => {
    expect(parseDeepLink(input, 'orkestra')).toEqual(expected);
  });

  it.each([
    'orkestra://task/../x',
    'orkestra://task/..',
    'orkestra://task/./x',
    'orkestra://task/id?cmd=rm%20-rf',
    'orkestra://task/id?',
    'orkestra://task/id#x',
    'orkestra://task/id#',
    'orkestra://user@task/id',
    'orkestra://user:pw@task/id',
    'orkestra://task@evil/id',
    'orkestra://task:80/id',
    'orkestra://task/id:80',
    'orkestra://task/id/extra',
    'orkestra://task/id//',
    'orkestra://task//id',
    'orkestra://task/',
    'orkestra://task',
    'orkestra://',
    'orkestra://task/%2e%2e',
    'orkestra://task/a%2fb',
    'orkestra://task/a%00b',
    'orkestra://task/a b',
    'orkestra://task/a\nb',
    'orkestra://task/a\\b',
    'orkestra://TASK/id',
    'orkestra://settings/id',
    'orkestra://run/id',
    'orkestra:task/id',
    'orkestra:/task/id',
    'orkestra:///task/id',
    'orkestra-canary://task/id',
    'app://orkestra/task/id',
    'https://orkestra/task/id',
    'xorkestra://task/id',
    ' orkestra://task/id',
    'orkestra://task/id ',
    'orkestra://task/-',
    '',
  ])('rejects %j', (input) => {
    expect(parseDeepLink(input, 'orkestra')).toBeUndefined();
  });

  it('rejects very long input and enforces the id length limit', () => {
    expect(parseDeepLink('orkestra://task/' + 'a'.repeat(5000), 'orkestra')).toBeUndefined();
    expect(parseDeepLink('orkestra://task/' + 'a'.repeat(128), 'orkestra')).toEqual({
      kind: 'task',
      id: 'a'.repeat(128),
    });
    expect(parseDeepLink('orkestra://task/' + 'a'.repeat(129), 'orkestra')).toBeUndefined();
    expect('orkestra://conversation/'.length + 128).toBeLessThan(DEEP_LINK_MAX_LENGTH);
  });

  it('rejects non-string input', () => {
    expect(parseDeepLink(undefined, 'orkestra')).toBeUndefined();
    expect(parseDeepLink(null, 'orkestra')).toBeUndefined();
    expect(parseDeepLink(42, 'orkestra')).toBeUndefined();
    expect(parseDeepLink({ toString: () => 'orkestra://task/id' }, 'orkestra')).toBeUndefined();
  });

  it('keeps canary and stable schemes separate', () => {
    expect(parseDeepLink('orkestra-canary://task/id', 'orkestra-canary')).toEqual({
      kind: 'task',
      id: 'id',
    });
    expect(parseDeepLink('orkestra://task/id', 'orkestra-canary')).toBeUndefined();
  });

  it('round-trips buildDeepLink', () => {
    const route = { kind: 'task', id: UUID } as const;
    expect(parseDeepLink(buildDeepLink(route, 'orkestra'), 'orkestra')).toEqual(route);
  });
});

describe('extractDeepLinkFromArgv', () => {
  it('takes only the single scheme-prefixed argument', () => {
    expect(
      extractDeepLinkFromArgv(['/app/Orkestra', '--flag', 'orkestra://task/abc'], 'orkestra')
    ).toBe('orkestra://task/abc');
  });

  it('ignores everything else', () => {
    expect(extractDeepLinkFromArgv(['/app', '--x=orkestra://task/abc'], 'orkestra')).toBeUndefined();
    expect(extractDeepLinkFromArgv([], 'orkestra')).toBeUndefined();
  });

  it('refuses ambiguous input with several links', () => {
    expect(
      extractDeepLinkFromArgv(['orkestra://task/a', 'orkestra://task/b'], 'orkestra')
    ).toBeUndefined();
  });

  it('does not accept another install scheme', () => {
    expect(extractDeepLinkFromArgv(['orkestra-canary://task/a'], 'orkestra')).toBeUndefined();
  });
});
