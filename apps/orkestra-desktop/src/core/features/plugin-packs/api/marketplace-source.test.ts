import { describe, expect, it } from 'vitest';
import { parseMarketplaceSource } from './marketplace-source';

describe('parseMarketplaceSource', () => {
  it('owner/repo biçimini GitHub https adresine çevirir', () => {
    expect(parseMarketplaceSource('anthropics/claude-plugins')).toEqual({
      success: true,
      data: {
        url: 'https://github.com/anthropics/claude-plugins.git',
        label: 'anthropics/claude-plugins',
      },
    });
  });

  it('https URL kabul eder ve normalize eder', () => {
    const result = parseMarketplaceSource('https://GitLab.com/grup/depo/');
    expect(result).toEqual({
      success: true,
      data: { url: 'https://gitlab.com/grup/depo', label: 'gitlab.com/grup/depo' },
    });
  });

  it.each([
    'file:///etc/passwd',
    'ssh://git@github.com/a/b',
    'git://github.com/a/b',
    'http://github.com/a/b',
    'git@github.com:a/b.git',
    '/Users/selim/depo',
    './yerel',
    '../yerel',
    '-u',
    '--upload-pack=calistir',
    '-oProxyCommand=x',
    'https://user:pass@github.com/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#frag',
    'https://github.com/a/../b',
    'https://github.com',
    'https://github.com/a/b c',
    'https://exa mple.com/a',
    'a/b/c',
    'a/..',
    '',
    '   ',
  ])('reddeder: %s', (input) => {
    expect(parseMarketplaceSource(input).success).toBe(false);
  });

  it('satır sonu ve NUL içeren değeri reddeder', () => {
    expect(parseMarketplaceSource('a/b\n--x').success).toBe(false);
    expect(parseMarketplaceSource('https://github.com/a/b\0').success).toBe(false);
  });
});
