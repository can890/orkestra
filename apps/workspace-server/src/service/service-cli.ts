// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/cli/service.ts ve
// apps/server/src/cloud/bootService.ts (kurulum/durum/onarım akışı, linger denetimi).
//
// `orkestra-workspace-server service install|status|restart|stop|uninstall|logs`.
// Tüm süreç çalıştırma enjekte edilen `runner` üzerinden yapılır; dosyalar `homeDirectory`
// altındaki yollara yazılır (testlerde geçici dizin).
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  renderEnvFileTemplate,
  renderServiceUnit,
  serviceCommandPlan,
  servicePaths,
  SERVICE_TARGETS,
  type DesktopDisplay,
  type ServicePlanInput,
  type ServicePlatform,
  type ServiceStep,
  type ServiceTarget,
} from './service-plan';

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export type ServiceCliDeps = {
  platform: NodeJS.Platform;
  homeDirectory: string;
  xdgConfigHome?: string;
  uid: number;
  username: string;
  run: CommandRunner;
  /** Bu CLI'nin kendisini çalıştıran komut (servis birimine yazılır). */
  cliProgram: readonly string[];
  cliVersion: string;
  /** `PATH` üzerinde bir programı bulur (`xvfb-run`); yoksa `null`. */
  which: (name: string) => Promise<string | null>;
  /** Varsayılan workspace-server soketi. */
  defaultSocketPath: string;
  /** Çalışan sunucunun sürümü (soket üzerinden `health`); erişilemezse `null`. */
  probeServerVersion?: (socketPath: string) => Promise<string | null>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const USAGE = `Usage: orkestra-workspace-server service <command> [options]

Commands:
  install     Install (or repair/upgrade in place) and start the background service
  status      Show whether the service is installed and running, its version and log path
  restart     Restart the service (also applies changes to the environment file)
  stop        Stop the service (it starts again at the next login/boot)
  uninstall   Stop the service and remove it from startup (keeps the env file and logs)
  logs        Print the end of the service log

Options:
  --target server|desktop-host   What to run (default: server)
  --socket <path>                server: Unix socket to listen on
  --app <path>                   desktop-host: Orkestra executable
  --display xvfb|existing        desktop-host: run under Xvfb (Linux default) or an existing display
  --workspace-socket [path]      desktop-host: share the workspace-server socket
                                 (SOVRA_LOCAL_WORKSPACE_SOCKET; default socket when no path)
  --memory-max <size>            systemd: hard memory limit, e.g. 6G (default: none)
  --no-start                     install without starting
  --dry-run                      print the unit and the commands without changing anything
  --lines <n>                    logs: number of lines (default 100)
`;

export async function runServiceCli(
  argv: readonly string[],
  deps: ServiceCliDeps
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    deps.stdout(USAGE);
    return command ? 0 : 1;
  }

  const servicePlatform = platformFor(deps.platform);
  if (!servicePlatform) {
    deps.stderr(
      `Background services are not supported on ${deps.platform}. Run "orkestra-workspace-server serve --socket" in a terminal instead, or use Linux (systemd) or macOS (launchd).\n`
    );
    return 1;
  }

  let options: ParsedOptions;
  try {
    options = parseServiceOptions(rest, deps);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const paths = servicePaths(
    options.target,
    servicePlatform,
    deps.homeDirectory,
    deps.xdgConfigHome
  );
  const plan = serviceCommandPlan(options.target, servicePlatform, {
    uid: deps.uid,
    unitFile: paths.unitFile,
    start: options.start,
  });
  const context: Context = { deps, options, servicePlatform, paths, plan };

  switch (command) {
    case 'install':
      return install(context);
    case 'status':
      return status(context);
    case 'restart':
      return runSteps(context, plan.restart, 'Restarted');
    case 'stop':
      return runSteps(context, plan.stop, 'Stopped');
    case 'uninstall':
      return uninstall(context);
    case 'logs':
      return logs(context);
    default:
      deps.stderr(`Unknown service command '${command}'.\n\n${USAGE}`);
      return 2;
  }
}

function platformFor(platform: NodeJS.Platform): ServicePlatform | null {
  if (platform === 'linux') return 'systemd';
  if (platform === 'darwin') return 'launchd';
  return null;
}

type ParsedOptions = {
  target: ServiceTarget;
  socketPath?: string;
  appPath?: string;
  display: DesktopDisplay;
  workspaceSocket?: string;
  memoryMax?: string;
  start: boolean;
  dryRun: boolean;
  lines: number;
};

type Context = {
  deps: ServiceCliDeps;
  options: ParsedOptions;
  servicePlatform: ServicePlatform;
  paths: ReturnType<typeof servicePaths>;
  plan: ReturnType<typeof serviceCommandPlan>;
};

function parseServiceOptions(argv: readonly string[], deps: ServiceCliDeps): ParsedOptions {
  // `--workspace-socket` değersiz de verilebilir; parseArgs için boş değere çevrilir.
  const normalized = argv.flatMap((arg, index) =>
    arg === '--workspace-socket' &&
    (argv[index + 1] === undefined || argv[index + 1]!.startsWith('--'))
      ? ['--workspace-socket=']
      : [arg]
  );
  const { values } = parseArgs({
    args: normalized,
    options: {
      target: { type: 'string' },
      socket: { type: 'string' },
      app: { type: 'string' },
      display: { type: 'string' },
      'workspace-socket': { type: 'string' },
      'memory-max': { type: 'string' },
      'no-start': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      lines: { type: 'string' },
    },
    strict: true,
  });
  const target = values.target ?? 'server';
  if (target !== 'server' && target !== 'desktop-host') {
    throw new Error(`Unknown --target '${target}' (use server or desktop-host)`);
  }
  const display = values.display ?? (deps.platform === 'linux' ? 'xvfb' : 'existing');
  if (display !== 'xvfb' && display !== 'existing') {
    throw new Error(`Unknown --display '${display}' (use xvfb or existing)`);
  }
  const memoryMax = values['memory-max'];
  if (memoryMax !== undefined && !/^\d+(?:\.\d+)?[KMGT]?$|^\d+%$/.test(memoryMax)) {
    throw new Error(`Invalid --memory-max '${memoryMax}' (use a size such as 6G or a percentage)`);
  }
  const lines = values.lines === undefined ? 100 : Number(values.lines);
  if (!Number.isInteger(lines) || lines <= 0) throw new Error('--lines must be a positive integer');
  const workspaceSocket = values['workspace-socket'];
  return {
    target,
    ...(values.socket ? { socketPath: absolute(values.socket, deps.homeDirectory) } : {}),
    ...(values.app ? { appPath: absolute(values.app, deps.homeDirectory) } : {}),
    display,
    ...(workspaceSocket !== undefined
      ? {
          workspaceSocket: workspaceSocket
            ? absolute(workspaceSocket, deps.homeDirectory)
            : deps.defaultSocketPath,
        }
      : {}),
    ...(memoryMax ? { memoryMax } : {}),
    start: !values['no-start'],
    dryRun: values['dry-run'] === true,
    lines,
  };
}

function absolute(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return resolve(path);
}

/** Uygulama yolu verilmediyse macOS'taki olağan kurulum yeri; Linux'ta (AppImage) yol zorunludur. */
function defaultAppPath(platform: NodeJS.Platform): string | null {
  return platform === 'darwin' ? '/Applications/Sovra.app/Contents/MacOS/Sovra' : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function buildPlanInput(context: Context): Promise<ServicePlanInput> {
  const { deps, options, servicePlatform, paths } = context;
  const base: ServicePlanInput = {
    target: options.target,
    platform: servicePlatform,
    cliProgram: deps.cliProgram,
    paths,
    ...(options.memoryMax ? { memoryMax: options.memoryMax } : {}),
  };
  if (options.target === 'server') {
    return { ...base, socketPath: options.socketPath ?? deps.defaultSocketPath };
  }
  const appPath = options.appPath ?? defaultAppPath(deps.platform);
  if (!appPath) {
    throw new Error(
      'Pass the Orkestra app executable with --app <path> (for example the AppImage you run on this machine).'
    );
  }
  if (!(await exists(appPath))) {
    throw new Error(
      `The Orkestra app was not found at ${appPath}. Pass its executable with --app <path>.`
    );
  }
  let xvfbRunPath: string | undefined;
  if (options.display === 'xvfb') {
    xvfbRunPath = (await deps.which('xvfb-run')) ?? undefined;
    if (!xvfbRunPath) {
      throw new Error(
        'xvfb-run was not found. Install Xvfb (for example "sudo apt install xvfb"), or pass --display existing when the machine has a display.'
      );
    }
  }
  return {
    ...base,
    appPath,
    display: options.display,
    ...(xvfbRunPath ? { xvfbRunPath } : {}),
    ...(options.workspaceSocket ? { workspaceSocket: options.workspaceSocket } : {}),
  };
}

function formatCommand(step: ServiceStep): string {
  return [step.command, ...step.args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(' ');
}

async function executeSteps(context: Context, steps: readonly ServiceStep[]): Promise<boolean> {
  const { deps } = context;
  for (const step of steps) {
    if (context.options.dryRun) {
      deps.stdout(`  would run: ${formatCommand(step)}\n`);
      continue;
    }
    let result: CommandResult;
    try {
      result = await deps.run(step.command, step.args);
    } catch (error) {
      result = {
        code: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.code === 0) continue;
    const detail = result.stderr.trim() || result.stdout.trim();
    if (step.optional) continue;
    deps.stderr(
      `Failed while ${step.description} (${formatCommand(step)} exited ${result.code})${detail ? `: ${detail}` : ''}\n`
    );
    return false;
  }
  return true;
}

async function runSteps(
  context: Context,
  steps: readonly ServiceStep[],
  done: string
): Promise<number> {
  if (!(await exists(context.paths.unitFile))) {
    context.deps.stderr(
      `The ${SERVICE_TARGETS[context.options.target].description} service is not installed. Run "orkestra-workspace-server service install${targetFlag(context)}" first.\n`
    );
    return 1;
  }
  if (!(await executeSteps(context, steps))) return 1;
  if (!context.options.dryRun) {
    context.deps.stdout(`${done} ${SERVICE_TARGETS[context.options.target].description}.\n`);
  }
  return 0;
}

function targetFlag(context: Context): string {
  return context.options.target === 'server' ? '' : ` --target ${context.options.target}`;
}

async function install(context: Context): Promise<number> {
  const { deps, options, paths } = context;
  let input: ServicePlanInput;
  try {
    input = await buildPlanInput(context);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let unit: string;
  try {
    unit = renderServiceUnit(input);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const previous = await readFile(paths.unitFile, 'utf8').catch(() => null);

  if (options.dryRun) {
    deps.stdout(`Would write ${paths.unitFile}:\n\n${unit}\n`);
    if (!(await exists(paths.envFile))) deps.stdout(`Would create ${paths.envFile}\n`);
    deps.stdout('Would run:\n');
    await executeSteps(context, context.plan.install);
    return 0;
  }

  const linger = context.servicePlatform === 'systemd' ? await readLinger(context) : 'n/a';

  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.unitFile), { recursive: true });
  if (!(await exists(paths.envFile))) {
    // Kurulum hiçbir zaman sır yazmaz; kullanıcı düzenleyebilir, yeniden kurulum dokunmaz.
    await writeFile(paths.envFile, renderEnvFileTemplate(options.target), { mode: 0o600 });
  }
  await writeFile(paths.unitFile, unit, { mode: 0o644 });

  if (!(await executeSteps(context, context.plan.install))) {
    deps.stderr(
      `The service files were written, but it could not be started. Read ${paths.logFile} and run "orkestra-workspace-server service status${targetFlag(context)}".\n`
    );
    return 1;
  }

  const description = SERVICE_TARGETS[options.target].description;
  const verb = previous === null ? 'Installed' : previous === unit ? 'Repaired' : 'Updated';
  deps.stdout(
    `${verb} the ${description} service${options.start ? ' and started it' : ''}.\n` +
      `  Unit: ${paths.unitFile}\n  Environment file: ${paths.envFile}\n  Log: ${paths.logFile}\n`
  );
  if (linger === 'no') {
    deps.stdout(
      `\nLingering is disabled: the service stops when your last login session ends and does not start at boot.\n` +
        `Ask an administrator to run:  sudo loginctl enable-linger "${deps.username}"\n` +
        `(over SSH: ssh -t <host> 'sudo loginctl enable-linger "$(id -un)"'). Then run this command again as your normal user.\n`
    );
  }
  if (context.servicePlatform === 'launchd') {
    deps.stdout(
      '\nmacOS starts the service when you log in and stops it when you log out. Keep this Mac logged in for unattended access.\n'
    );
  }
  return 0;
}

type Linger = 'yes' | 'no' | 'unknown' | 'n/a';

async function readLinger(context: Context): Promise<Linger> {
  try {
    const result = await context.deps.run('loginctl', [
      'show-user',
      context.deps.username,
      '--property=Linger',
    ]);
    if (result.code !== 0) return 'unknown';
    const value = /Linger=(yes|no)/.exec(result.stdout)?.[1];
    return value === 'yes' || value === 'no' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseProperties(text: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([\w-]+)\s*(?:=|:)\s*(.*)$/.exec(line);
    if (match) properties[match[1]!] = match[2]!.trim();
  }
  return properties;
}

async function status(context: Context): Promise<number> {
  const { deps, options, paths, plan } = context;
  const description = SERVICE_TARGETS[options.target].description;
  const installed = await exists(paths.unitFile);
  const lines = [`${description} (${context.servicePlatform})`];
  lines.push(`  Installed: ${installed ? `yes (${paths.unitFile})` : 'no'}`);

  let running = false;
  let pid: string | undefined;
  let problem: string | undefined;
  if (installed) {
    const result = await deps.run(plan.status.command, plan.status.args).catch(() => null);
    if (context.servicePlatform === 'systemd') {
      const properties = result?.code === 0 ? parseProperties(result.stdout) : {};
      running = properties.ActiveState === 'active';
      pid = properties.MainPID && properties.MainPID !== '0' ? properties.MainPID : undefined;
      if (!result || result.code !== 0) problem = 'user-manager-unavailable';
      else if (properties.UnitFileState && properties.UnitFileState !== 'enabled') {
        problem = 'service-disabled';
      } else if (!running) problem = 'service-stopped';
    } else {
      if (!result || result.code !== 0) {
        problem = 'not-loaded';
      } else {
        const properties = parseProperties(result.stdout);
        running = properties.state === 'running';
        pid = properties.pid;
        if (!running) problem = 'service-stopped';
      }
    }
  }
  lines.push(`  Running: ${running ? `yes${pid ? ` (pid ${pid})` : ''}` : 'no'}`);
  lines.push(`  CLI version: ${deps.cliVersion}`);
  if (options.target === 'server' && running && deps.probeServerVersion) {
    const socket = options.socketPath ?? deps.defaultSocketPath;
    const version = await deps.probeServerVersion(socket).catch(() => null);
    lines.push(`  Server version: ${version ?? 'unreachable'} (${socket})`);
    if (version && version !== deps.cliVersion) problem ??= 'restart-pending';
  }
  lines.push(`  Environment file: ${paths.envFile}`);
  lines.push(`  Log: ${paths.logFile}`);
  if (context.servicePlatform === 'systemd') {
    const linger = await readLinger(context);
    lines.push(`  Survives logout (linger): ${linger}`);
    if (linger === 'no') problem ??= 'linger-disabled';
  }
  if (problem) lines.push(`  Problem: ${problem} — ${problemAdvice(problem, context)}`);
  deps.stdout(`${lines.join('\n')}\n`);
  return installed && running ? 0 : 3;
}

function problemAdvice(problem: string, context: Context): string {
  const flag = targetFlag(context);
  switch (problem) {
    case 'linger-disabled':
      return `run: sudo loginctl enable-linger "${context.deps.username}"`;
    case 'user-manager-unavailable':
      return 'run "systemctl --user status" in a login session and check systemd user-session support';
    case 'restart-pending':
      return `a newer version is installed; run "orkestra-workspace-server service restart${flag}"`;
    case 'not-loaded':
      return `run "orkestra-workspace-server service install${flag}" to load it again`;
    default:
      return `read the log, then run "orkestra-workspace-server service install${flag}" to repair it`;
  }
}

async function uninstall(context: Context): Promise<number> {
  const { deps, paths, plan, options } = context;
  const installed = await exists(paths.unitFile);
  if (!installed) {
    deps.stdout(`The ${SERVICE_TARGETS[options.target].description} service is not installed.\n`);
    return 0;
  }
  if (options.dryRun) {
    deps.stdout('Would run:\n');
    await executeSteps(context, plan.uninstall);
    deps.stdout(`Would remove ${paths.unitFile}\n`);
    await executeSteps(context, plan.afterRemove);
    return 0;
  }
  if (!(await executeSteps(context, plan.uninstall))) return 1;
  // Yalnızca kendi birim dosyamızı sileriz; ortam dosyası ve günlükler kalır.
  await rm(paths.unitFile, { force: true });
  if (!(await executeSteps(context, plan.afterRemove))) return 1;
  deps.stdout(
    `Uninstalled the ${SERVICE_TARGETS[options.target].description} service. Kept ${paths.envFile} and ${paths.logFile}.\n`
  );
  return 0;
}

async function logs(context: Context): Promise<number> {
  const { deps, paths, options } = context;
  const text = await readFile(paths.logFile, 'utf8').catch(() => null);
  if (text === null) {
    deps.stderr(`No log yet at ${paths.logFile}.\n`);
    return 1;
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  deps.stdout(`==> ${paths.logFile} <==\n${lines.slice(-options.lines).join('\n')}\n`);
  return 0;
}
