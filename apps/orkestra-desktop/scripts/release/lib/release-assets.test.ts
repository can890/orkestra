import { describe, expect, it } from 'vitest';
import {
  expectedManifestFiles,
  expectedReleaseAssets,
  findMissingReleaseAssets,
  isPlatformReleaseAsset,
  releaseIdentity,
} from './release-assets.ts';

describe('expectedReleaseAssets', () => {
  it('requires all stable installers and manifests', () => {
    const assets = expectedReleaseAssets('stable');

    expect(assets).toContain('orkestra-x86_64.AppImage');
    expect(assets).toContain('orkestra-amd64.deb');
    expect(assets).toContain('orkestra-x86_64.rpm');
    expect(assets).toContain('orkestra-arm64.AppImage');
    expect(assets).toContain('orkestra-arm64.deb');
    expect(assets).toContain('orkestra-aarch64.rpm');
    expect(assets).toContain('latest-linux.yml');
    expect(assets).toContain('latest-linux-arm64.yml');
    expect(assets).toContain('v1-stable-linux.yml');
    expect(assets).toContain('v1-stable-linux-arm64.yml');
  });

  it('requires the complete canary architecture set', () => {
    const assets = expectedReleaseAssets('canary');
    expect(assets).toContain('orkestra-canary-arm64.dmg');
    expect(assets).toContain('orkestra-canary-arm64.AppImage');
    expect(assets).toContain('canary-linux-arm64.yml');
    expect(assets).toContain('orkestra-canary-x64.dmg');
    expect(assets).toContain('orkestra-canary-x86_64.AppImage');
    expect(assets).toContain('canary-linux.yml');
    expect(assets).toEqual(
      expect.arrayContaining(['orkestra-canary-x64.exe', 'orkestra-canary-x64.msi', 'canary.yml'])
    );
  });
});

describe('findMissingReleaseAssets', () => {
  it('returns only absent assets', () => {
    expect(findMissingReleaseAssets(['one', 'three'], ['one', 'two', 'three'])).toEqual(['two']);
  });
});

describe('releaseIdentity', () => {
  it('keeps GitHub and R2 channel identities explicit', () => {
    expect(releaseIdentity('stable')).toEqual({
      artifactPrefix: 'orkestra',
      githubChannel: 'latest',
      r2Channel: 'v1-stable',
    });
    expect(releaseIdentity('canary')).toEqual({
      artifactPrefix: 'orkestra-canary',
      githubChannel: 'canary',
      r2Channel: 'v1-canary',
    });
  });
});

describe('isPlatformReleaseAsset', () => {
  it('selects only final artifacts and manifests for the requested platform', () => {
    expect(isPlatformReleaseAsset('orkestra-arm64.dmg', 'stable', 'mac')).toBe(true);
    expect(isPlatformReleaseAsset('orkestra-arm64.zip.blockmap', 'stable', 'mac')).toBe(true);
    expect(isPlatformReleaseAsset('latest-mac.yml', 'stable', 'mac')).toBe(true);
    expect(isPlatformReleaseAsset('v1-stable-mac.yml', 'stable', 'mac')).toBe(true);
    expect(isPlatformReleaseAsset('orkestra-arm64.AppImage', 'stable', 'linux')).toBe(true);
    expect(isPlatformReleaseAsset('latest-linux-arm64.yml', 'stable', 'linux')).toBe(true);
    expect(isPlatformReleaseAsset('orkestra-x64.exe', 'stable', 'win')).toBe(true);
    expect(isPlatformReleaseAsset('v1-stable.yml', 'stable', 'win')).toBe(true);
  });

  it('rejects other-platform, other-channel, and debug files', () => {
    expect(isPlatformReleaseAsset('orkestra-arm64.dmg', 'stable', 'linux')).toBe(false);
    expect(isPlatformReleaseAsset('canary-mac.yml', 'stable', 'mac')).toBe(false);
    expect(isPlatformReleaseAsset('orkestra-canary-arm64.dmg', 'stable', 'mac')).toBe(false);
    expect(isPlatformReleaseAsset('builder-debug.yml', 'stable', 'mac')).toBe(false);
    expect(isPlatformReleaseAsset('orkestra-arm64.dmg.sha256', 'stable', 'mac')).toBe(false);
  });
});

describe('expectedManifestFiles', () => {
  it('requires the complete architecture set', () => {
    const manifests = expectedManifestFiles('stable');

    expect(manifests.get('latest-mac.yml')).toEqual([
      'orkestra-x64.zip',
      'orkestra-x64.dmg',
      'orkestra-arm64.zip',
      'orkestra-arm64.dmg',
    ]);
    expect(manifests.get('v1-stable-mac.yml')).toEqual([
      'orkestra-x64.zip',
      'orkestra-x64.dmg',
      'orkestra-arm64.zip',
      'orkestra-arm64.dmg',
    ]);
    expect(manifests.get('latest-linux.yml')).toEqual([
      'orkestra-x86_64.AppImage',
      'orkestra-amd64.deb',
      'orkestra-x86_64.rpm',
    ]);
    expect(manifests.get('latest-linux-arm64.yml')).toEqual([
      'orkestra-arm64.AppImage',
      'orkestra-arm64.deb',
      'orkestra-aarch64.rpm',
    ]);
  });

  it('requires both canary Linux manifests', () => {
    const manifests = expectedManifestFiles('canary');

    expect(manifests.get('canary-linux.yml')).toEqual([
      'orkestra-canary-x86_64.AppImage',
      'orkestra-canary-amd64.deb',
      'orkestra-canary-x86_64.rpm',
    ]);
    expect(manifests.get('v1-canary-linux-arm64.yml')).toEqual([
      'orkestra-canary-arm64.AppImage',
      'orkestra-canary-arm64.deb',
      'orkestra-canary-aarch64.rpm',
    ]);
  });
});
