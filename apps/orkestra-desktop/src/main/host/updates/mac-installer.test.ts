import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateRefusedError, type ExecFile } from './code-signature';
import { MacInAppInstaller, type InstallableRelease, type MacInstallerDeps } from './mac-installer';

const DR =
  'identifier "com.orkestra.stable" and certificate leaf = H"119df61cb690b67ea932f6cefccee19c6a4197b2"';
const DOWNLOAD = 'https://github.com/can890/orkestra/releases/download/v1.2.22';
const ZIP = Buffer.from('zip-bytes');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function release(overrides: Partial<InstallableRelease> = {}): InstallableRelease {
  return {
    version: '1.2.22',
    assets: [
      { name: 'orkestra-arm64.zip', url: `${DOWNLOAD}/orkestra-arm64.zip`, size: ZIP.length },
      { name: 'SHA256SUMS', url: `${DOWNLOAD}/SHA256SUMS` },
    ],
    ...overrides,
  };
}

async function setup(options: { runningDr?: string; sums?: string; candidateDr?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-mac-installer-'));
  dirs.push(root);
  const appsDir = join(root, 'Applications');
  await mkdir(join(appsDir, 'Orkestra.app', 'Contents', 'MacOS'), { recursive: true });
  const userData = join(root, 'userData');
  const temp = join(root, 'temp');
  await mkdir(temp);

  const exec = vi.fn<ExecFile>(async (file, args) => {
    if (file === '/usr/bin/codesign' && args[0] === '-d') {
      const running = args[2]!.startsWith(appsDir);
      const dr = running ? (options.runningDr ?? DR) : (options.candidateDr ?? DR);
      return { stdout: `designated => ${dr}\n`, stderr: '' };
    }
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: '' };
    if (file === '/usr/bin/plutil') {
      const value = args[1] === 'CFBundleIdentifier' ? 'com.orkestra.stable' : '1.2.22';
      return { stdout: value, stderr: '' };
    }
    if (file === '/usr/bin/ditto') {
      // Sahte açma: zip yerine boş bir uygulama paketi oluşturur.
      await mkdir(join(args[3]!, 'Orkestra.app', 'Contents'), { recursive: true });
      await writeFile(join(args[3]!, 'Orkestra.app', 'Contents', 'Info.plist'), '<plist/>');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${file}`);
  });
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    if (url.endsWith('SHA256SUMS')) {
      return new Response(options.sums ?? `${ZIP_SHA}  orkestra-arm64.zip\n`);
    }
    return new Response(ZIP);
  });
  const spawnDetached = vi.fn(async (_file: string, _args: readonly string[]) => {});
  const deps: MacInstallerDeps = {
    platform: 'darwin',
    arch: 'arm64',
    pid: 4242,
    isPackaged: () => true,
    exePath: () => join(appsDir, 'Orkestra.app', 'Contents', 'MacOS', 'Orkestra'),
    userDataDir: () => userData,
    tempDir: () => temp,
    userAgent: () => 'Orkestra/1.2.21',
    fetch,
    exec,
    spawnDetached,
  };
  return {
    installer: new MacInAppInstaller(deps),
    exec,
    fetch,
    spawnDetached,
    userData,
    temp,
    appsDir,
  };
}

describe('MacInAppInstaller', () => {
  it('downloads, verifies the checksum and signature, and writes the helper', async () => {
    const { installer, exec, spawnDetached, userData, appsDir } = await setup();
    await expect(installer.checkSupport()).resolves.toMatchObject({ supported: true });

    const progress = vi.fn();
    const prepared = await installer.prepare(release(), progress);
    expect(prepared.version).toBe('1.2.22');
    expect(prepared.appPath.endsWith('/extracted/Orkestra.app')).toBe(true);
    expect(await readFile(join(userData, 'updates', '1.2.22', 'orkestra-arm64.zip'))).toEqual(ZIP);
    expect(progress).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '-R', `=${DR}`, prepared.appPath],
      expect.anything()
    );
    await expect(installer.isPrepared(prepared)).resolves.toBe(true);

    await installer.launchInstaller(prepared);
    const scriptPath = join(prepared.workDir, 'install.sh');
    expect(spawnDetached).toHaveBeenCalledWith('/bin/sh', [scriptPath]);
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain('PARENT_PID=4242');
    expect(script).toContain(join(appsDir, 'Orkestra.app'));
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o700);
  });

  it('deletes a download whose checksum does not match', async () => {
    const { installer, userData } = await setup({
      sums: `${'0'.repeat(64)}  orkestra-arm64.zip\n`,
    });
    await expect(installer.prepare(release(), () => {})).rejects.toThrow(
      'SHA256SUMS ile eşleşmiyor'
    );
    await expect(stat(join(userData, 'updates', '1.2.22', 'orkestra-arm64.zip'))).rejects.toThrow();
  });

  it('refuses a candidate signed with another identity and removes the extraction', async () => {
    const { installer, temp } = await setup({ candidateDr: DR.replace('119df61c', '00000000') });
    await expect(installer.prepare(release(), () => {})).rejects.toBeInstanceOf(UpdateRefusedError);
    expect(await readdir(temp)).toEqual([]);
  });

  it.each<[string, Partial<InstallableRelease>, string]>([
    [
      'the zip is missing',
      { assets: [{ name: 'SHA256SUMS', url: `${DOWNLOAD}/SHA256SUMS` }] },
      'paketi yok',
    ],
    [
      'SHA256SUMS is missing',
      { assets: [{ name: 'orkestra-arm64.zip', url: `${DOWNLOAD}/orkestra-arm64.zip` }] },
      'SHA256SUMS dosyası yok',
    ],
    [
      'an asset points elsewhere',
      {
        assets: [
          { name: 'orkestra-arm64.zip', url: 'https://example.com/orkestra-arm64.zip' },
          { name: 'SHA256SUMS', url: `${DOWNLOAD}/SHA256SUMS` },
        ],
      },
      'Beklenmeyen indirme adresi',
    ],
  ])('refuses a release where %s', async (_name, overrides, message) => {
    const { installer, fetch } = await setup();
    await expect(installer.prepare(release(overrides), () => {})).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports ad-hoc installs as unsupported', async () => {
    const { installer } = await setup({ runningDr: 'cdhash H"abcd"' });
    await expect(installer.checkSupport()).resolves.toMatchObject({
      supported: false,
      reason: expect.stringContaining('ad-hoc'),
    });
    await expect(installer.prepare(release(), () => {})).rejects.toBeInstanceOf(UpdateRefusedError);
  });

  it('reads the previous failure once and cleans caches of installed versions', async () => {
    const { installer, userData } = await setup();
    const updates = join(userData, 'updates');
    await mkdir(join(updates, '1.2.20'), { recursive: true });
    await mkdir(join(updates, '1.2.21'), { recursive: true });
    await mkdir(join(updates, '1.2.22'), { recursive: true });
    await writeFile(join(updates, 'install-result.txt'), 'Eski sürüm geri yüklendi.\n');

    await expect(installer.takeInstallFailure()).resolves.toBe('Eski sürüm geri yüklendi.');
    await expect(installer.takeInstallFailure()).resolves.toBeNull();
    await installer.cleanup('1.2.21');
    expect((await readdir(updates)).sort()).toEqual(['1.2.22']);
  });
});
