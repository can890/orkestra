import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from './utils';

describe('compareVersions', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('1.2.18', '1.2.17')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.17', '1.2.17')).toBe(0);
    expect(compareVersions('1.2.9', '1.2.10')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('ranks pre-releases below the matching release', () => {
    expect(compareVersions('1.3.0-beta.2', '1.3.0')).toBeLessThan(0);
    expect(compareVersions('1.3.0-beta.10', '1.3.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0-beta.1', '1.2.17')).toBeGreaterThan(0);
  });

  it('returns null for versions it cannot parse', () => {
    expect(compareVersions('nightly', '1.2.17')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('v1.2.17+build.5')).toEqual({
      major: 1,
      minor: 2,
      patch: 17,
      prerelease: null,
    });
  });
});
