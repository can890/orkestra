import { describe, expect, it, vi } from 'vitest';
import {
  checkInstallLocation,
  isTranslocated,
  resolveBundlePath,
  type InstallLocationInput,
} from './install-location';

const EXE = '/Applications/Orkestra.app/Contents/MacOS/Orkestra';

function input(overrides: Partial<InstallLocationInput> = {}): InstallLocationInput {
  return {
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    exePath: EXE,
    isWritable: vi.fn(async () => true),
    ...overrides,
  };
}

describe('install location', () => {
  it('resolves the bundle from the executable path', () => {
    expect(resolveBundlePath(EXE)).toBe('/Applications/Orkestra.app');
    expect(resolveBundlePath('/usr/local/bin/orkestra')).toBeNull();
  });

  it('detects App Translocation', () => {
    expect(isTranslocated('/private/var/folders/x/T/AppTranslocation/ABC-123/d/Orkestra.app')).toBe(
      true
    );
    expect(isTranslocated('/Applications/Orkestra.app')).toBe(false);
  });

  it('supports a writable packaged arm64 app in Applications', async () => {
    await expect(checkInstallLocation(input())).resolves.toEqual({
      supported: true,
      bundlePath: '/Applications/Orkestra.app',
    });
  });

  it('supports a writable app in the home Applications folder', async () => {
    await expect(
      checkInstallLocation(
        input({ exePath: '/Users/a/Applications/Orkestra.app/Contents/MacOS/Orkestra' })
      )
    ).resolves.toMatchObject({ supported: true });
  });

  it.each<[string, Partial<InstallLocationInput>, string]>([
    ['other platforms', { platform: 'linux' }, 'yalnızca macOS'],
    ['Intel builds', { arch: 'x64' }, 'arm64'],
    ['development builds', { isPackaged: false }, 'Geliştirme'],
    [
      'translocated apps',
      {
        exePath: '/private/var/folders/x/AppTranslocation/A/d/Orkestra.app/Contents/MacOS/Orkestra',
      },
      'Applications klasörüne taşıyıp',
    ],
    [
      'mounted disk images',
      { exePath: '/Volumes/Orkestra/Orkestra.app/Contents/MacOS/Orkestra' },
      'disk görüntüsünden',
    ],
    [
      'read-only folders',
      { isWritable: vi.fn(async (path: string) => path.endsWith('.app')) },
      'yazma izni yok (/Applications)',
    ],
    [
      'a read-only bundle',
      { isWritable: vi.fn(async (path: string) => !path.endsWith('.app')) },
      'yazma izni yok',
    ],
  ])('falls back to manual installs for %s', async (_name, overrides, reason) => {
    const result = await checkInstallLocation(input(overrides));
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.reason).toContain(reason);
  });
});
