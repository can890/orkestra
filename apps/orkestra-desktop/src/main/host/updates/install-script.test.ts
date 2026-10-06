import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInstallScript, installScriptPaths, type InstallScriptParams } from './install-script';

const REQUIREMENT =
  'identifier "com.orkestra.stable" and certificate leaf = H"119df61cb690b67ea932f6cefccee19c6a4197b2"';

function params(overrides: Partial<InstallScriptParams> = {}): InstallScriptParams {
  return {
    parentPid: 4242,
    targetApp: '/Applications/Orkestra.app',
    sourceApp: '/private/var/folders/T/orkestra-update-a/extracted/Orkestra.app',
    requirement: REQUIREMENT,
    logFile: '/Users/a/Library/Application Support/Orkestra/updates/install.log',
    resultFile: '/Users/a/Library/Application Support/Orkestra/updates/install-result.txt',
    cleanupDir: '/private/var/folders/T/orkestra-update-a',
    stamp: '1700000000000',
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('buildInstallScript', () => {
  it('stages next to the target so the swap is an atomic rename', () => {
    expect(installScriptPaths('/Applications/Orkestra.app', '17')).toEqual({
      staged: '/Applications/.Orkestra.app.update-17',
      backup: '/Applications/.Orkestra.app.previous-17',
    });
  });

  it('quotes every value and orders wait → copy → verify → swap → rollback → relaunch', () => {
    const script = buildInstallScript(params());
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('PARENT_PID=4242');
    expect(script).toContain(`REQUIREMENT='${REQUIREMENT}'`);
    expect(script).toContain(
      "LOG_FILE='/Users/a/Library/Application Support/Orkestra/updates/install.log'"
    );
    expect(script).toContain('WAIT_LIMIT=600');

    const order = [
      'kill -0 "$PARENT_PID"',
      'ditto "$SOURCE" "$STAGED"',
      'xattr -dr com.apple.quarantine "$STAGED"',
      'codesign --verify --deep --strict -R "=$REQUIREMENT" "$STAGED"',
      'mv "$TARGET" "$BACKUP"',
      'if ! mv "$STAGED" "$TARGET"; then',
      'if mv "$BACKUP" "$TARGET"; then',
      'rm -rf "$BACKUP"\nrm -f "$RESULT_FILE"',
      'relaunch\nrm -rf "$CLEANUP_DIR"',
    ].map((needle) => {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('escapes single quotes so paths cannot break out of the assignment', () => {
    const script = buildInstallScript(
      params({ targetApp: "/Users/a/Apps/O'rkestra $(rm -rf ~).app" })
    );
    expect(script).toContain(`TARGET='/Users/a/Apps/O'\\''rkestra $(rm -rf ~).app'`);
  });

  it.each<[string, Partial<InstallScriptParams>]>([
    ['a relative target', { targetApp: 'Orkestra.app' }],
    ['a non-bundle target', { targetApp: '/Applications/Orkestra' }],
    ['a root cleanup dir', { cleanupDir: '/' }],
    ['a shallow cleanup dir', { cleanupDir: '/tmp' }],
    ['a non-normalised path', { sourceApp: '/private/var/../etc/Orkestra.app' }],
    ['newlines in paths', { logFile: '/Users/a/x\nrm -rf /' }],
    ['an unsafe stamp', { stamp: '1; rm -rf /' }],
    ['an invalid pid', { parentPid: 1 }],
    ['an empty requirement', { requirement: ' ' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => buildInstallScript(params(overrides))).toThrow();
  });

  it.runIf(process.platform === 'darwin')(
    'swaps the bundle, and rolls back when the new one cannot be moved in',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orkestra-install-'));
      dirs.push(root);
      const bin = join(root, 'bin');
      await mkdir(bin);
      // Sahte codesign/open: gerçek imza denetimi ve uygulama açma testte çalışmasın.
      for (const tool of ['codesign', 'open']) {
        await writeFile(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${root}/calls"\n`);
        await chmod(join(bin, tool), 0o755);
      }
      const apps = join(root, 'Applications');
      const target = join(apps, 'Orkestra.app');
      await mkdir(join(target, 'Contents'), { recursive: true });
      await writeFile(join(target, 'Contents', 'version'), 'old');
      const work = join(root, 'work');
      const source = join(work, 'extracted', 'Orkestra.app');
      await mkdir(join(source, 'Contents'), { recursive: true });
      await writeFile(join(source, 'Contents', 'version'), 'new');
      await mkdir(join(root, 'logs'));

      const run = async (script: string) => {
        const scriptPath = join(root, `install-${Math.random().toString(36).slice(2)}.sh`);
        await writeFile(scriptPath, script.replace('PATH=/usr/bin:', `PATH=${bin}:/usr/bin:`));
        return spawnSync('/bin/sh', [scriptPath], { encoding: 'utf8' });
      };
      const base = {
        parentPid: 999_999,
        targetApp: target,
        sourceApp: source,
        requirement: REQUIREMENT,
        logFile: join(root, 'logs', 'install.log'),
        resultFile: join(root, 'logs', 'install-result.txt'),
        cleanupDir: work,
        waitTimeoutSeconds: 1,
      };

      // Yeni paketin yerine konamadığı durumu taklit etmek için ikinci mv adımını başarısız say.
      const failing = buildInstallScript({ ...base, stamp: 'a' }).replace(
        'if ! mv "$STAGED" "$TARGET"; then',
        'if ! false; then'
      );
      const rolledBack = await run(failing);
      expect(rolledBack.status).toBe(1);
      expect(await readFile(join(target, 'Contents', 'version'), 'utf8')).toBe('old');
      expect(await readFile(base.resultFile, 'utf8')).toContain('eski sürüm geri yüklendi');
      await expect(stat(join(apps, '.Orkestra.app.update-a'))).rejects.toThrow();

      const ok = await run(buildInstallScript({ ...base, stamp: 'b' }));
      expect(ok.status).toBe(0);
      expect(await readFile(join(target, 'Contents', 'version'), 'utf8')).toBe('new');
      await expect(stat(join(apps, '.Orkestra.app.previous-b'))).rejects.toThrow();
      await expect(stat(work)).rejects.toThrow();
      await expect(stat(base.resultFile)).rejects.toThrow();
      const calls = await readFile(join(root, 'calls'), 'utf8');
      expect(calls).toContain(`codesign --verify --deep --strict -R =${REQUIREMENT}`);
      expect(calls).toContain(`open ${target}`);
    }
  );
});
