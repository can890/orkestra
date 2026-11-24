import { describe, expect, it } from 'vitest';
import {
  renderEnvFileTemplate,
  renderServiceUnit,
  serviceCommandPlan,
  servicePaths,
  type ServicePlanInput,
} from './service-plan';

const HOME = '/home/selim';
const MAC_HOME = '/Users/selim';
const CLI = ['/home/selim/.orkestra/workspace-server/current/bin/orkestra-workspace-server'];
const MAC_CLI = ['/Users/selim/.orkestra/workspace-server/current/bin/orkestra-workspace-server'];

function linuxServer(overrides: Partial<ServicePlanInput> = {}): ServicePlanInput {
  return {
    target: 'server',
    platform: 'systemd',
    cliProgram: CLI,
    paths: servicePaths('server', 'systemd', HOME),
    socketPath: `${HOME}/.orkestra/workspace-server/run/workspace.sock`,
    ...overrides,
  };
}

function linuxDesktopHost(overrides: Partial<ServicePlanInput> = {}): ServicePlanInput {
  return {
    target: 'desktop-host',
    platform: 'systemd',
    cliProgram: CLI,
    paths: servicePaths('desktop-host', 'systemd', HOME),
    appPath: '/opt/Orkestra/orkestra',
    display: 'xvfb',
    xvfbRunPath: '/usr/bin/xvfb-run',
    workspaceSocket: `${HOME}/.orkestra/workspace-server/run/workspace.sock`,
    memoryMax: '6G',
    ...overrides,
  };
}

describe('service units (golden files)', () => {
  it('renders the systemd unit for the workspace server', async () => {
    await expect(renderServiceUnit(linuxServer())).toMatchFileSnapshot(
      './__golden__/orkestra-workspace-server.service'
    );
  });

  it('renders the systemd unit for the headless desktop host', async () => {
    await expect(renderServiceUnit(linuxDesktopHost())).toMatchFileSnapshot(
      './__golden__/orkestra-desktop-host.service'
    );
  });

  it('renders the launchd plist for the workspace server', async () => {
    await expect(
      renderServiceUnit({
        target: 'server',
        platform: 'launchd',
        cliProgram: MAC_CLI,
        paths: servicePaths('server', 'launchd', MAC_HOME),
        socketPath: `${MAC_HOME}/.orkestra/workspace-server/run/workspace.sock`,
      })
    ).toMatchFileSnapshot('./__golden__/com.orkestra.workspace-server.plist');
  });

  it('renders the launchd plist for the desktop host on an existing display', async () => {
    await expect(
      renderServiceUnit({
        target: 'desktop-host',
        platform: 'launchd',
        cliProgram: MAC_CLI,
        paths: servicePaths('desktop-host', 'launchd', MAC_HOME),
        appPath: '/Applications/Orkestra.app/Contents/MacOS/Orkestra',
        display: 'existing',
      })
    ).toMatchFileSnapshot('./__golden__/com.orkestra.desktop-host.plist');
  });

  it('renders the environment file templates', async () => {
    await expect(renderEnvFileTemplate('server')).toMatchFileSnapshot(
      './__golden__/orkestra-workspace-server.env'
    );
    await expect(renderEnvFileTemplate('desktop-host')).toMatchFileSnapshot(
      './__golden__/orkestra-desktop-host.env'
    );
  });
});

describe('unit rendering details', () => {
  it('quotes paths with spaces and escapes systemd specifiers', () => {
    const unit = renderServiceUnit(
      linuxServer({
        cliProgram: ['/home/selim/My Tools/orkestra-workspace-server'],
        paths: servicePaths('server', 'systemd', '/home/sel%im'),
      })
    );
    expect(unit).toContain(
      'ExecStart="/home/selim/My Tools/orkestra-workspace-server" service run'
    );
    expect(unit).toContain('StandardOutput=append:/home/sel%%im/.orkestra/service/logs/');
  });

  it('refuses a program path systemd cannot run', () => {
    expect(() => renderServiceUnit(linuxServer({ cliProgram: ['/home/a"b/cli'] }))).toThrow(
      /quotes or control characters/
    );
  });

  it('escapes XML in launchd arguments', () => {
    const plist = renderServiceUnit({
      target: 'server',
      platform: 'launchd',
      cliProgram: ['/Users/a&b/cli'],
      paths: servicePaths('server', 'launchd', '/Users/a&b'),
    });
    expect(plist).toContain('<string>/Users/a&amp;b/cli</string>');
  });

  it('never writes secrets into the environment file template', () => {
    for (const target of ['server', 'desktop-host'] as const) {
      const lines = renderEnvFileTemplate(target)
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'));
      expect(lines).toEqual([]);
    }
  });

  it('honours XDG_CONFIG_HOME for the systemd unit directory', () => {
    expect(servicePaths('server', 'systemd', HOME, '/srv/config').unitFile).toBe(
      '/srv/config/systemd/user/orkestra-workspace-server.service'
    );
    expect(servicePaths('server', 'systemd', HOME, 'relative').unitFile).toBe(
      `${HOME}/.config/systemd/user/orkestra-workspace-server.service`
    );
  });
});

describe('command plans', () => {
  it('systemd: install, restart, stop, uninstall', () => {
    const plan = serviceCommandPlan('server', 'systemd', {
      uid: 1000,
      unitFile: '/x.service',
      start: true,
    });
    const commands = (steps: typeof plan.install) =>
      steps.map((step) => [step.command, ...step.args].join(' '));
    expect(commands(plan.install)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable orkestra-workspace-server.service',
      'systemctl --user reset-failed orkestra-workspace-server.service',
      'systemctl --user restart orkestra-workspace-server.service',
    ]);
    expect(commands(plan.restart)).toEqual([
      'systemctl --user reset-failed orkestra-workspace-server.service',
      'systemctl --user restart orkestra-workspace-server.service',
    ]);
    expect(commands(plan.stop)).toEqual([
      'systemctl --user stop orkestra-workspace-server.service',
    ]);
    expect(commands(plan.uninstall)).toEqual([
      'systemctl --user disable --now orkestra-workspace-server.service',
    ]);
    expect(commands(plan.afterRemove)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user reset-failed orkestra-workspace-server.service',
    ]);
  });

  it('launchd: install, restart, stop, uninstall', () => {
    const plan = serviceCommandPlan('desktop-host', 'launchd', {
      uid: 501,
      unitFile: '/Users/selim/Library/LaunchAgents/com.orkestra.desktop-host.plist',
      start: true,
    });
    const commands = (steps: typeof plan.install) =>
      steps.map((step) => [step.command, ...step.args].join(' '));
    expect(commands(plan.install)).toEqual([
      'launchctl bootout --wait gui/501/com.orkestra.desktop-host',
      'launchctl enable gui/501/com.orkestra.desktop-host',
      'launchctl bootstrap gui/501 /Users/selim/Library/LaunchAgents/com.orkestra.desktop-host.plist',
    ]);
    expect(commands(plan.restart)).toEqual([
      'launchctl kickstart -k gui/501/com.orkestra.desktop-host',
    ]);
    expect(commands(plan.stop)).toEqual([
      'launchctl bootout --wait gui/501/com.orkestra.desktop-host',
    ]);
    expect(commands(plan.uninstall)).toEqual([
      'launchctl bootout --wait gui/501/com.orkestra.desktop-host',
    ]);
  });

  it('skips the start step with --no-start', () => {
    const plan = serviceCommandPlan('server', 'systemd', {
      uid: 1000,
      unitFile: '/x',
      start: false,
    });
    expect(plan.install.map((step) => step.args.at(1))).not.toContain('restart');
  });
});
