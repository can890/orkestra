import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChromeExtensionOperations,
  getChromeExtensionInfo,
  resolveChromeExtensionDir,
} from './chrome-extension-locator';

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-chrome-ext-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveChromeExtensionDir', () => {
  it('paketliyse resources altındaki klasörü verir', () => {
    expect(
      resolveChromeExtensionDir({
        isPackaged: true,
        resourcesPath: '/App/Resources',
        appPath: '/App/Resources/app.asar',
      })
    ).toBe('/App/Resources/chrome-extension');
  });

  it('paketsizse uygulama dizininin kardeşi apps/chrome-extension klasörünü verir', () => {
    expect(
      resolveChromeExtensionDir({
        isPackaged: false,
        resourcesPath: '/ignored',
        appPath: '/repo/apps/orkestra-desktop',
      })
    ).toBe('/repo/apps/chrome-extension');
  });
});

describe('getChromeExtensionInfo', () => {
  it('klasör ve manifest varsa sürümü okur', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'chrome-extension'));
    await writeFile(join(root, 'chrome-extension', 'manifest.json'), '{"version":"1.2.3"}');
    const info = await getChromeExtensionInfo({
      isPackaged: true,
      resourcesPath: root,
      appPath: '/unused',
    });
    expect(info).toEqual({
      path: join(root, 'chrome-extension'),
      available: true,
      version: '1.2.3',
    });
  });

  it('klasör yoksa kullanılamaz döner', async () => {
    const root = await tempRoot();
    const info = await getChromeExtensionInfo({
      isPackaged: true,
      resourcesPath: root,
      appPath: '/unused',
    });
    expect(info).toEqual({
      path: join(root, 'chrome-extension'),
      available: false,
      version: null,
    });
  });

  it('manifest bozuksa ya da yoksa kullanılamaz döner', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'chrome-extension'));
    const deps = { isPackaged: true, resourcesPath: root, appPath: '/unused' };
    expect((await getChromeExtensionInfo(deps)).available).toBe(false);
    await writeFile(join(root, 'chrome-extension', 'manifest.json'), '{bozuk');
    expect((await getChromeExtensionInfo(deps)).available).toBe(false);
  });

  it('sürüm metin değilse sürümü null bırakır', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'chrome-extension'));
    await writeFile(join(root, 'chrome-extension', 'manifest.json'), '{"version":3}');
    const info = await getChromeExtensionInfo({
      isPackaged: true,
      resourcesPath: root,
      appPath: '/unused',
    });
    expect(info).toMatchObject({ available: true, version: null });
  });
});

describe('createChromeExtensionOperations', () => {
  async function setup(platform: NodeJS.Platform, withExtension = true) {
    const root = await tempRoot();
    if (withExtension) {
      await mkdir(join(root, 'chrome-extension'));
      await writeFile(join(root, 'chrome-extension', 'manifest.json'), '{"version":"0.1.0"}');
    }
    const showItemInFolder = vi.fn();
    const runFile = vi.fn(async (_file: string, _args: readonly string[]) => {});
    const operations = createChromeExtensionOperations({
      location: { isPackaged: true, resourcesPath: root, appPath: '/unused' },
      showItemInFolder,
      runFile,
      platform,
    });
    return { root, showItemInFolder, runFile, operations };
  }

  it('klasörü yalnızca kendi çözdüğü yolla gösterir', async () => {
    const { root, showItemInFolder, operations } = await setup('darwin');
    expect(await operations.revealExtensionFolder()).toEqual({ revealed: true });
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(root, 'chrome-extension'));
  });

  it('klasör yoksa Finder açmaz', async () => {
    const { showItemInFolder, operations } = await setup('darwin', false);
    expect(await operations.revealExtensionFolder()).toEqual({ revealed: false });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('shell hata verirse revealed:false döner', async () => {
    const { showItemInFolder, operations } = await setup('darwin');
    showItemInFolder.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await operations.revealExtensionFolder()).toEqual({ revealed: false });
  });

  it("macOS'ta Chrome'u sabit argv ile açar", async () => {
    const { runFile, operations } = await setup('darwin');
    expect(await operations.openChromeExtensionsPage()).toEqual({ opened: true });
    expect(runFile).toHaveBeenCalledExactlyOnceWith('open', [
      '-a',
      'Google Chrome',
      'chrome://extensions',
    ]);
  });

  it('Chrome yoksa (süreç hata verir) opened:false döner', async () => {
    const { runFile, operations } = await setup('darwin');
    runFile.mockRejectedValue(new Error('Unable to find application'));
    expect(await operations.openChromeExtensionsPage()).toEqual({ opened: false });
  });

  it('macOS dışında süreç çalıştırmaz', async () => {
    const { runFile, operations } = await setup('linux');
    expect(await operations.openChromeExtensionsPage()).toEqual({ opened: false });
    expect(runFile).not.toHaveBeenCalled();
  });
});
