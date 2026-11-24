import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveKind,
  normalizeRegistryCommandPath,
  parseNpxPackageSpec,
  parseUvxPackageSpec,
  resolveAcpRegistryDistribution,
  resolveAcpRegistryPlatformTarget,
  validateArchiveEntries,
} from '../api/distribution';
import { parseAcpRegistryIndex, type AcpRegistryAgent } from '../api/registry-schema';

const agents = parseAcpRegistryIndex(
  readFileSync(join(__dirname, 'fixtures/registry-index.fixture.json'), 'utf8')
).agents;
const agent = (id: string): AcpRegistryAgent => agents.find((candidate) => candidate.id === id)!;

const PLATFORMS = [
  ['darwin', 'arm64', 'darwin-aarch64'],
  ['darwin', 'x64', 'darwin-x86_64'],
  ['linux', 'x64', 'linux-x86_64'],
  ['linux', 'arm64', 'linux-aarch64'],
  ['win32', 'x64', 'windows-x86_64'],
] as const;

describe('resolveAcpRegistryPlatformTarget', () => {
  it.each(PLATFORMS)('%s/%s → %s', (platform, arch, target) => {
    expect(resolveAcpRegistryPlatformTarget(platform, arch)).toBe(target);
  });

  it('returns undefined for unsupported platforms', () => {
    expect(resolveAcpRegistryPlatformTarget('freebsd', 'x64')).toBeUndefined();
    expect(resolveAcpRegistryPlatformTarget('linux', 'ia32')).toBeUndefined();
  });
});

describe('resolveAcpRegistryDistribution matrix', () => {
  const resolve = (id: string, platform: string, arch: string, preference?: 'npx') =>
    resolveAcpRegistryDistribution({
      agent: agent(id),
      platformTarget: resolveAcpRegistryPlatformTarget(platform, arch),
      ...(preference ? { preference } : {}),
    });

  it.each(PLATFORMS)('binary agent on %s/%s uses its own target', (platform, arch, target) => {
    const resolved = resolve('amp-acp', platform, arch)!;
    expect(resolved.kind).toBe('binary');
    expect(resolved.platformTarget).toBe(target);
    expect(resolved.binaryTarget?.archive).toContain('amp-acp');
  });

  it.each(PLATFORMS)('npx agent on %s/%s resolves the exact package', (platform, arch) => {
    expect(resolve('gemini', platform, arch)).toEqual({
      kind: 'npx',
      args: ['--acp'],
      env: {},
      packageSpec: '@google/gemini-cli@0.71.1',
    });
  });

  it.each(PLATFORMS)('uvx agent on %s/%s keeps its args and env', (platform, arch) => {
    expect(resolve('fast-agent', platform, arch)).toMatchObject({
      kind: 'uvx',
      args: ['-x'],
      env: { FAST_AGENT_MODEL: 'codexplan' },
      packageSpec: 'fast-agent-acp==0.10.66',
    });
  });

  it('prefers binary over npx in auto mode and honours an explicit preference', () => {
    expect(resolve('claude-acp', 'darwin', 'arm64')?.kind).toBe('binary');
    expect(resolve('claude-acp', 'darwin', 'arm64', 'npx')?.kind).toBe('npx');
  });

  it('has no distribution where a binary-only agent lacks the target', () => {
    // Kimi (legacy) yalnızca darwin-aarch64 yayımlar; darwin-x86_64 desteklenmez.
    expect(resolve('kimi', 'darwin', 'x64')).toBeUndefined();
    expect(resolve('kimi', 'darwin', 'arm64')?.kind).toBe('binary');
  });

  it('falls back from windows-aarch64 to windows-x86_64 binaries', () => {
    const resolved = resolve('amp-acp', 'win32', 'arm64')!;
    expect(resolved.platformTarget).toBe('windows-x86_64');
  });

  it('only offers package distributions on an unsupported platform', () => {
    expect(resolve('amp-acp', 'freebsd', 'x64')).toBeUndefined();
    expect(resolve('gemini', 'freebsd', 'x64')?.kind).toBe('npx');
  });
});

describe('registry path and package helpers', () => {
  it('normalizes command paths and rejects escapes', () => {
    expect(normalizeRegistryCommandPath('./bin/devin')).toEqual(['bin', 'devin']);
    expect(normalizeRegistryCommandPath('./bin\\devin.exe')).toEqual(['bin', 'devin.exe']);
    expect(normalizeRegistryCommandPath('../evil')).toBeUndefined();
    expect(normalizeRegistryCommandPath('/usr/bin/evil')).toBeUndefined();
    expect(normalizeRegistryCommandPath('C:/evil')).toBeUndefined();
    expect(normalizeRegistryCommandPath('')).toBeUndefined();
  });

  it('validates archive listings', () => {
    expect(validateArchiveEntries('./\nbin/\nbin/devin\n')).toBe(true);
    expect(validateArchiveEntries('bin/devin\n../../etc/passwd\n')).toBe(false);
    expect(validateArchiveEntries('/abs/path\n')).toBe(false);
  });

  it('detects archive kinds', () => {
    expect(archiveKind('https://x/a.tar.gz')).toBe('tar_gz');
    expect(archiveKind('https://x/a.tgz')).toBe('tar_gz');
    expect(archiveKind('https://x/a.tar.bz2')).toBe('tar_bz2');
    expect(archiveKind('https://x/a.zip')).toBe('zip');
    expect(archiveKind('https://x/agent')).toBe('raw');
  });

  it('parses exact package specs', () => {
    expect(parseNpxPackageSpec('@google/gemini-cli@0.71.1')).toEqual({
      name: '@google/gemini-cli',
      version: '0.71.1',
    });
    expect(parseUvxPackageSpec('fast-agent-acp==0.10.66')).toEqual({
      name: 'fast-agent-acp',
      version: '0.10.66',
    });
    expect(parseUvxPackageSpec('minion-code@v0.1.44')).toEqual({
      name: 'minion-code',
      version: '0.1.44',
    });
  });
});
