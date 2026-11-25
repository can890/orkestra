import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinuxTargetHelper } from 'app-builder-lib/out/targets/LinuxTargetHelper';
import { AppInfo, LinuxPackager, Packager } from 'electron-builder';
import { describe, expect, it } from 'vitest';
import canaryConfig from '../../../electron-builder.canary.config.ts';
import stableConfig from '../../../electron-builder.config.ts';
import packageJson from '../../../package.json';
import { createReleaseBuildConfig } from './build-config.ts';

const packageFile = fileURLToPath(new URL('../../../package.json', import.meta.url));
const projectDir = dirname(packageFile);

// The product was renamed to Sovra in 36ee0935; the Linux desktop id deliberately stays the
// old one so existing launchers and installs keep matching.
describe.each([
  { channel: 'stable', baseConfig: stableConfig, desktopId: 'Orkestra', productName: 'Sovra' },
  {
    channel: 'canary',
    baseConfig: canaryConfig,
    desktopId: 'orkestra-canary',
    productName: 'Sovra Canary',
  },
])('$channel Linux desktop identity', ({ channel, baseConfig, desktopId, productName }) => {
  it.each(['local', 'release'])('matches the %s launcher on Wayland and X11', async (mode) => {
    const versionOverride =
      mode === 'release' && channel === 'canary' ? '9.9.9-canary.123' : undefined;
    const config =
      mode === 'release'
        ? createReleaseBuildConfig(
            baseConfig,
            packageJson.devDependencies.electron,
            versionOverride
          )
        : structuredClone(baseConfig);
    const packager = new Packager({ projectDir, config });
    await packager.validateConfig();
    packager._appInfo = new AppInfo(packager, null);
    const linuxPackager = new LinuxPackager(packager);
    // Exercise the builder's desktop generator and merged package metadata without
    // downloading Electron or invoking native Linux packaging tools.
    const helper = new LinuxTargetHelper(linuxPackager);
    const desktopEntry = await helper.computeDesktopEntry(
      linuxPackager.platformSpecificBuildOptions
    );
    const metadata = packager.metadata;

    expect(metadata.desktopName).toBe(`${desktopId}.desktop`);
    expect(helper.getDesktopFileName()).toBe(desktopId);
    expect(helper.getDesktopFileName('different-executable')).toBe(desktopId);
    expect(metadata.desktopName).toBe(`${helper.getDesktopFileName()}.desktop`);
    expect(desktopEntry).toContain(`\nStartupWMClass=${productName}\n`);
    expect(desktopEntry).toContain(`\nName=${productName}\n`);
    expect(config.productName).toBe(productName);
    expect(metadata.version).toBe(versionOverride ?? packageJson.version);
  });
});

describe('createReleaseBuildConfig', () => {
  it('isolates nested configuration between architecture builds', () => {
    const original = structuredClone(canaryConfig);
    const first = createReleaseBuildConfig(canaryConfig, packageJson.devDependencies.electron);
    const second = createReleaseBuildConfig(canaryConfig, packageJson.devDependencies.electron);

    expect(first.files).not.toBe(second.files);
    expect(first.extraMetadata).not.toBe(second.extraMetadata);
    expect(first.linux?.desktop?.entry).not.toBe(second.linux?.desktop?.entry);
    expect(canaryConfig).toEqual(original);
  });
});

describe.each([
  { channel: 'stable', baseConfig: stableConfig },
  { channel: 'canary', baseConfig: canaryConfig },
])('$channel Chrome extension packaging', ({ baseConfig }) => {
  it('ships the unpacked Chrome extension as a resource without sources or docs', () => {
    const resources = (baseConfig.extraResources ?? []) as unknown[];
    const entry = resources.find(
      (item): item is { from: string; to: string; filter: string[] } =>
        typeof item === 'object' &&
        item !== null &&
        (item as { to?: string }).to === 'chrome-extension'
    );
    expect(entry).toBeDefined();
    expect(existsSync(resolve(projectDir, entry!.from, 'manifest.json'))).toBe(true);
    expect(entry!.filter).toEqual(expect.arrayContaining(['!**/*.d.ts', '!README.md']));
  });

  it('keeps the release config clone independent of the extension resource', () => {
    const config = createReleaseBuildConfig(baseConfig, packageJson.devDependencies.electron);
    expect(config.extraResources).toEqual(baseConfig.extraResources);
  });
});
