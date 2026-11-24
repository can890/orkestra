import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  desktopHostCommand,
  parseServiceRunArgs,
  readServiceEnvironment,
  runDesktopHost,
  type SpawnFn,
} from './service-run';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orkestra-service-run-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readServiceEnvironment', () => {
  it('applies literal KEY=VALUE entries and protects the service identity', async () => {
    const file = join(dir, 'service.env');
    await writeFile(
      file,
      [
        '# comment',
        'SOVRA_HOST_NAME="build box"',
        'LITERAL=$HOME/not-expanded',
        'HOME=/tmp/evil',
        'ORKESTRA_SERVICE_UNIT=other',
        '',
      ].join('\n')
    );
    const env = await readServiceEnvironment(file, { HOME: '/home/selim', KEEP: '1' });
    expect(env).toMatchObject({
      HOME: '/home/selim',
      KEEP: '1',
      SOVRA_HOST_NAME: 'build box',
      LITERAL: '$HOME/not-expanded',
    });
    expect(env.ORKESTRA_SERVICE_UNIT).toBeUndefined();
  });

  it('ignores a missing file', async () => {
    expect(await readServiceEnvironment(join(dir, 'missing.env'), { A: '1' })).toEqual({ A: '1' });
  });
});

describe('desktop host launch', () => {
  it('parses the arguments the unit passes', () => {
    expect(
      parseServiceRunArgs([
        '--target',
        'desktop-host',
        '--app',
        '/opt/Orkestra/orkestra',
        '--display',
        'xvfb',
        '--xvfb-run',
        '/usr/bin/xvfb-run',
        '--workspace-socket',
        '/run/ws.sock',
      ])
    ).toEqual({
      target: 'desktop-host',
      appPath: '/opt/Orkestra/orkestra',
      display: 'xvfb',
      xvfbRunPath: '/usr/bin/xvfb-run',
      workspaceSocket: '/run/ws.sock',
    });
    expect(parseServiceRunArgs(['--target', 'server', '--socket', '/s'])).toEqual({
      target: 'server',
      socketPath: '/s',
    });
    expect(() => parseServiceRunArgs(['--target', 'desktop-host'])).toThrow(/--app/);
  });

  it('runs Electron under Xvfb with GPU disabled and the shared socket', () => {
    const command = desktopHostCommand(
      {
        target: 'desktop-host',
        appPath: '/opt/Orkestra/orkestra',
        display: 'xvfb',
        xvfbRunPath: '/usr/bin/xvfb-run',
        workspaceSocket: '/run/ws.sock',
      },
      { PATH: '/usr/bin' }
    );
    expect(command.command).toBe('/usr/bin/xvfb-run');
    expect(command.args).toEqual([
      '-a',
      '-s',
      '-screen 0 1920x1080x24',
      '/opt/Orkestra/orkestra',
      '--disable-gpu',
      '--disable-gpu-compositing',
    ]);
    expect(command.env).toMatchObject({
      PATH: '/usr/bin',
      SOVRA_HEADLESS: '1',
      SOVRA_LOCAL_WORKSPACE_SOCKET: '/run/ws.sock',
    });
  });

  it('forwards SIGTERM to the child and returns its exit code', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const signals = new EventEmitter();
    const running = runDesktopHost(
      { target: 'desktop-host', appPath: '/app', display: 'existing' },
      {},
      spawnFn,
      signals as unknown as NodeJS.Process
    );
    expect(spawnFn).toHaveBeenCalledWith(
      '/app',
      ['--disable-gpu', '--disable-gpu-compositing'],
      expect.objectContaining({ stdio: 'inherit' })
    );
    signals.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, null);
    expect(await running).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
