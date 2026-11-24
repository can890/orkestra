import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runServiceCli, type CommandResult, type ServiceCliDeps } from './service-cli';

type Call = string;

let home: string;
let calls: Call[];
let out: string;
let err: string;
let responses: Array<(command: string, args: readonly string[]) => CommandResult | undefined>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orkestra-service-home-'));
  calls = [];
  out = '';
  err = '';
  responses = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function deps(overrides: Partial<ServiceCliDeps> = {}): ServiceCliDeps {
  return {
    platform: 'linux',
    homeDirectory: home,
    uid: 1000,
    username: 'selim',
    cliProgram: [`${home}/.orkestra/workspace-server/current/bin/orkestra-workspace-server`],
    cliVersion: '0.1.15',
    defaultSocketPath: `${home}/.orkestra/workspace-server/run/workspace.sock`,
    which: async () => null,
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      for (const respond of responses) {
        const result = respond(command, args);
        if (result) return result;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...overrides,
  };
}

const unitPath = () => join(home, '.config/systemd/user/orkestra-workspace-server.service');
const plistPath = () => join(home, 'Library/LaunchAgents/com.orkestra.workspace-server.plist');
const envPath = () => join(home, '.orkestra/service/orkestra-workspace-server.env');

describe('service install on Linux (systemd)', () => {
  it('writes the unit and env file, then runs the exact command sequence', async () => {
    responses.push((command) =>
      command === 'loginctl' ? { code: 0, stdout: 'Linger=yes\n', stderr: '' } : undefined
    );
    expect(await runServiceCli(['install'], deps())).toBe(0);
    expect(calls).toEqual([
      'loginctl show-user selim --property=Linger',
      'systemctl --user daemon-reload',
      'systemctl --user enable orkestra-workspace-server.service',
      'systemctl --user reset-failed orkestra-workspace-server.service',
      'systemctl --user restart orkestra-workspace-server.service',
    ]);
    const unit = await readFile(unitPath(), 'utf8');
    expect(unit).toContain(
      `ExecStart=${home}/.orkestra/workspace-server/current/bin/orkestra-workspace-server service run --target server --socket ${home}/.orkestra/workspace-server/run/workspace.sock`
    );
    expect((await stat(envPath())).mode & 0o777).toBe(0o600);
    expect(out).toMatch(/^Installed the Orkestra workspace server service and started it\./);
    expect(out).not.toContain('Lingering is disabled');
  });

  it('is idempotent: re-install repairs, an upgrade updates in place, the env file survives', async () => {
    expect(await runServiceCli(['install'], deps())).toBe(0);
    await writeFile(envPath(), 'MY_SETTING=1\n');
    calls = [];
    out = '';
    expect(await runServiceCli(['install'], deps())).toBe(0);
    expect(out).toMatch(/^Repaired/);
    expect(calls.filter((call) => call.startsWith('systemctl'))).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable orkestra-workspace-server.service',
      'systemctl --user reset-failed orkestra-workspace-server.service',
      'systemctl --user restart orkestra-workspace-server.service',
    ]);
    out = '';
    expect(
      await runServiceCli(['install'], deps({ cliProgram: ['/opt/new/orkestra-workspace-server'] }))
    ).toBe(0);
    expect(out).toMatch(/^Updated/);
    expect(await readFile(unitPath(), 'utf8')).toContain(
      'ExecStart=/opt/new/orkestra-workspace-server'
    );
    expect(await readFile(envPath(), 'utf8')).toBe('MY_SETTING=1\n');
  });

  it('prints enable-linger guidance without running sudo', async () => {
    responses.push((command) =>
      command === 'loginctl' ? { code: 0, stdout: 'Linger=no\n', stderr: '' } : undefined
    );
    expect(await runServiceCli(['install'], deps())).toBe(0);
    expect(out).toContain('sudo loginctl enable-linger "selim"');
    expect(calls.some((call) => call.startsWith('sudo'))).toBe(false);
  });

  it('reports a failed start and keeps the files', async () => {
    responses.push((command, args) =>
      command === 'systemctl' && args.includes('restart')
        ? { code: 1, stdout: '', stderr: 'Job failed' }
        : undefined
    );
    expect(await runServiceCli(['install'], deps())).toBe(1);
    expect(err).toContain('Failed while starting the service');
    expect(err).toContain('Job failed');
    await stat(unitPath());
  });

  it('dry-run changes nothing and runs nothing', async () => {
    expect(await runServiceCli(['install', '--dry-run'], deps())).toBe(0);
    expect(calls).toEqual([]);
    await expect(stat(unitPath())).rejects.toThrow();
    expect(out).toContain('would run: systemctl --user daemon-reload');
  });

  it('installs the headless desktop host under Xvfb with a memory limit', async () => {
    const app = join(home, 'Orkestra', 'orkestra');
    await mkdir(join(home, 'Orkestra'));
    await writeFile(app, '#!/bin/sh\n');
    await chmod(app, 0o755);
    expect(
      await runServiceCli(
        [
          'install',
          '--target',
          'desktop-host',
          '--app',
          app,
          '--workspace-socket',
          '--memory-max',
          '6G',
        ],
        deps({ which: async (name) => (name === 'xvfb-run' ? '/usr/bin/xvfb-run' : null) })
      )
    ).toBe(0);
    const unit = await readFile(
      join(home, '.config/systemd/user/orkestra-desktop-host.service'),
      'utf8'
    );
    expect(unit).toContain(
      `service run --target desktop-host --app ${app} --display xvfb --xvfb-run /usr/bin/xvfb-run --workspace-socket ${home}/.orkestra/workspace-server/run/workspace.sock`
    );
    expect(unit).toContain('MemoryMax=6G');
    expect(unit).toContain('Wants=orkestra-workspace-server.service');
    expect(calls).toContain('systemctl --user restart orkestra-desktop-host.service');
  });

  it('explains a missing Xvfb or app instead of installing', async () => {
    expect(await runServiceCli(['install', '--target', 'desktop-host'], deps())).toBe(1);
    expect(err).toMatch(/--app <path>/);
    const app = join(home, 'orkestra');
    await writeFile(app, '');
    err = '';
    expect(await runServiceCli(['install', '--target', 'desktop-host', '--app', app], deps())).toBe(
      1
    );
    expect(err).toMatch(/xvfb-run was not found/);
    expect(calls.filter((call) => call.startsWith('systemctl'))).toEqual([]);
  });

  it('uninstall stops, removes the unit, reloads, and keeps the env file and logs', async () => {
    await runServiceCli(['install'], deps());
    calls = [];
    expect(await runServiceCli(['uninstall'], deps())).toBe(0);
    expect(calls).toEqual([
      'systemctl --user disable --now orkestra-workspace-server.service',
      'systemctl --user daemon-reload',
      'systemctl --user reset-failed orkestra-workspace-server.service',
    ]);
    await expect(stat(unitPath())).rejects.toThrow();
    await stat(envPath());
  });

  it('restart and stop refuse when nothing is installed', async () => {
    expect(await runServiceCli(['restart'], deps())).toBe(1);
    expect(await runServiceCli(['stop'], deps())).toBe(1);
    expect(calls).toEqual([]);
  });

  it('status reports installed, running, version, log path and linger', async () => {
    await runServiceCli(['install'], deps());
    responses.push((command, args) =>
      command === 'systemctl' && args[1] === 'show'
        ? {
            code: 0,
            stdout:
              'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\n',
            stderr: '',
          }
        : command === 'loginctl'
          ? { code: 0, stdout: 'Linger=no\n', stderr: '' }
          : undefined
    );
    out = '';
    const code = await runServiceCli(
      ['status'],
      deps({ probeServerVersion: async () => '0.1.14' })
    );
    expect(code).toBe(0);
    expect(out).toContain('Installed: yes');
    expect(out).toContain('Running: yes (pid 4242)');
    expect(out).toContain('CLI version: 0.1.15');
    expect(out).toContain('Server version: 0.1.14');
    expect(out).toContain(`Log: ${home}/.orkestra/service/logs/orkestra-workspace-server.log`);
    expect(out).toContain('Survives logout (linger): no');
    expect(out).toContain('Problem: restart-pending');
  });

  it('status exits non-zero when not installed', async () => {
    expect(await runServiceCli(['status'], deps())).toBe(3);
    expect(out).toContain('Installed: no');
  });

  it('logs prints the end of the log file', async () => {
    await mkdir(join(home, '.orkestra/service/logs'), { recursive: true });
    await writeFile(
      join(home, '.orkestra/service/logs/orkestra-workspace-server.log'),
      'a\nb\nc\n'
    );
    expect(await runServiceCli(['logs', '--lines', '2'], deps())).toBe(0);
    expect(out).toContain('b\nc\n');
    expect(out).not.toContain('a\n');
  });
});

describe('service on macOS (launchd)', () => {
  const mac = () => deps({ platform: 'darwin', uid: 501 });

  it('install writes the plist and bootstraps the agent', async () => {
    expect(await runServiceCli(['install'], mac())).toBe(0);
    expect(calls).toEqual([
      'launchctl bootout --wait gui/501/com.orkestra.workspace-server',
      'launchctl enable gui/501/com.orkestra.workspace-server',
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
    expect(await readFile(plistPath(), 'utf8')).toContain(
      '<string>com.orkestra.workspace-server</string>'
    );
  });

  it('a failing bootout of an unloaded agent does not stop the install (upgrade path)', async () => {
    responses.push((command, args) =>
      command === 'launchctl' && args[0] === 'bootout'
        ? { code: 3, stdout: '', stderr: 'No such process' }
        : undefined
    );
    expect(await runServiceCli(['install'], mac())).toBe(0);
  });

  it('restart, stop and uninstall use launchctl', async () => {
    await runServiceCli(['install'], mac());
    calls = [];
    expect(await runServiceCli(['restart'], mac())).toBe(0);
    expect(await runServiceCli(['stop'], mac())).toBe(0);
    expect(await runServiceCli(['uninstall'], mac())).toBe(0);
    expect(calls).toEqual([
      'launchctl kickstart -k gui/501/com.orkestra.workspace-server',
      'launchctl bootout --wait gui/501/com.orkestra.workspace-server',
      'launchctl bootout --wait gui/501/com.orkestra.workspace-server',
    ]);
    await expect(stat(plistPath())).rejects.toThrow();
  });

  it('status parses launchctl print', async () => {
    await runServiceCli(['install'], mac());
    responses.push((command, args) =>
      command === 'launchctl' && args[0] === 'print'
        ? {
            code: 0,
            stdout: 'gui/501/com.orkestra.workspace-server = {\n\tstate = running\n\tpid = 77\n}',
            stderr: '',
          }
        : undefined
    );
    out = '';
    expect(await runServiceCli(['status'], mac())).toBe(0);
    expect(out).toContain('Running: yes (pid 77)');
    expect(out).not.toContain('linger');
  });
});

describe('unsupported platforms and bad input', () => {
  it('says Windows is not supported', async () => {
    expect(await runServiceCli(['install'], deps({ platform: 'win32' }))).toBe(1);
    expect(err).toMatch(/not supported on win32/);
    expect(calls).toEqual([]);
  });

  it('rejects unknown commands and options', async () => {
    expect(await runServiceCli(['explode'], deps())).toBe(2);
    expect(await runServiceCli(['install', '--target', 'nope'], deps())).toBe(2);
    expect(await runServiceCli(['install', '--memory-max', 'lots'], deps())).toBe(2);
    expect(calls).toEqual([]);
  });
});
