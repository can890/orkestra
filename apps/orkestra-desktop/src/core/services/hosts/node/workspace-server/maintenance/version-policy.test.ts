import { describe, expect, it } from 'vitest';
import { compareServerVersions, isDevBuildVersion } from './version-policy';

describe('compareServerVersions', () => {
  it('reports a newer channel version as an available update', () => {
    expect(compareServerVersions('1.2.3', '1.2.4')).toBe('update-available');
    expect(compareServerVersions('1.2.3', '1.10.0')).toBe('update-available');
    expect(compareServerVersions('1.2.3-beta.1', '1.2.3')).toBe('update-available');
  });

  it('treats an equal or newer running version as up to date', () => {
    expect(compareServerVersions('1.2.4', '1.2.4')).toBe('up-to-date');
    expect(compareServerVersions('1.3.0', '1.2.9')).toBe('up-to-date');
  });

  it('ignores dev builds on either side', () => {
    expect(compareServerVersions('1.2.3-dev.abc123.1234', '1.2.4')).toBe('dev-build');
    expect(compareServerVersions('1.2.3', '1.2.4-dev.manual')).toBe('dev-build');
    expect(isDevBuildVersion('0.1.0-dev')).toBe(true);
    expect(isDevBuildVersion('0.1.0-devel.1')).toBe(false);
  });

  it('returns unknown for missing or invalid versions', () => {
    expect(compareServerVersions(undefined, '1.2.3')).toBe('unknown');
    expect(compareServerVersions('1.2.3', undefined)).toBe('unknown');
    expect(compareServerVersions('latest', '1.2.3')).toBe('unknown');
    expect(compareServerVersions('1.2.3', '01.2.3')).toBe('unknown');
  });
});
