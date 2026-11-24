// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/serviceLauncher.ts
// (readServiceEnvironment).
//
// `service run`: servis yöneticisinin (systemd/launchd) başlattığı başlatıcı. Ortam dosyasını
// okur, sonra ya workspace-server'ı aynı süreçte sunar ya da başsız Electron ana bilgisayarını
// alt süreç olarak çalıştırıp sinyalleri ona iletir.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import {
  HEADLESS_ELECTRON_FLAGS,
  SERVICE_UNIT_ENV,
  type DesktopDisplay,
  type ServiceTarget,
} from './service-plan';

/** Ortam dosyasının değiştiremeyeceği adlar (servisin kimliği ve ev dizini). */
const PROTECTED_ENV_NAMES = new Set(['HOME', SERVICE_UNIT_ENV]);

/**
 * Ortam dosyasını devralınan ortamın üzerine uygular. Eksik dosya yok sayılır; başka bir okuma
 * hatası servisi başlatmaz (yanlış ortamla sessizce çalışmaktansa).
 */
export async function readServiceEnvironment(
  envFile: string,
  inherited: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await readFile(envFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return environment;
    throw error;
  }
  for (const [name, value] of Object.entries(parseEnv(contents))) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PROTECTED_ENV_NAMES.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

export type ServiceRunOptions =
  | { target: 'server'; socketPath?: string }
  | {
      target: 'desktop-host';
      appPath: string;
      display: DesktopDisplay;
      xvfbRunPath?: string;
      workspaceSocket?: string;
    };

export function parseServiceRunArgs(argv: readonly string[]): ServiceRunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      target: { type: 'string' },
      socket: { type: 'string' },
      app: { type: 'string' },
      display: { type: 'string' },
      'xvfb-run': { type: 'string' },
      'workspace-socket': { type: 'string' },
    },
    strict: true,
  });
  const target = (values.target ?? 'server') as ServiceTarget;
  if (target === 'server') {
    return { target, ...(values.socket ? { socketPath: values.socket } : {}) };
  }
  if (target !== 'desktop-host') throw new Error(`Unknown service target '${String(target)}'`);
  if (!values.app) throw new Error('service run --target desktop-host needs --app <path>');
  const display = (values.display ?? 'existing') as DesktopDisplay;
  if (display !== 'xvfb' && display !== 'existing') {
    throw new Error(`Unknown display '${display}' (use xvfb or existing)`);
  }
  if (display === 'xvfb' && !values['xvfb-run']) {
    throw new Error('--display xvfb needs --xvfb-run <path>');
  }
  return {
    target,
    appPath: values.app,
    display,
    ...(values['xvfb-run'] ? { xvfbRunPath: values['xvfb-run'] } : {}),
    ...(values['workspace-socket'] ? { workspaceSocket: values['workspace-socket'] } : {}),
  };
}

/** Başsız ana bilgisayarın tam komutu ve ortamı (saf; testler doğrular). */
export function desktopHostCommand(
  options: Extract<ServiceRunOptions, { target: 'desktop-host' }>,
  environment: NodeJS.ProcessEnv
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const app = [options.appPath, ...HEADLESS_ELECTRON_FLAGS];
  const env: NodeJS.ProcessEnv = {
    ...environment,
    // Uygulama bu bayrakla GPU sürecini kapatır ve hata kutusu göstermez.
    SOVRA_HEADLESS: '1',
    ...(options.workspaceSocket ? { SOVRA_LOCAL_WORKSPACE_SOCKET: options.workspaceSocket } : {}),
  };
  if (options.display === 'xvfb' && options.xvfbRunPath) {
    // `-a`: boş bir ekran numarası seç; ekran 1920x1080 24 bit.
    return {
      command: options.xvfbRunPath,
      args: ['-a', '-s', '-screen 0 1920x1080x24', ...app],
      env,
    };
  }
  const [command, ...args] = app;
  return { command: command!, args, env };
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Ana bilgisayarı çalıştırır, SIGTERM/SIGINT'i iletir ve alt sürecin çıkış koduyla döner.
 * systemd `KillMode=mixed` ile önce bu sürece SIGTERM gönderir.
 */
export function runDesktopHost(
  options: Extract<ServiceRunOptions, { target: 'desktop-host' }>,
  environment: NodeJS.ProcessEnv,
  spawnFn: SpawnFn = spawn,
  signals: Pick<NodeJS.Process, 'on' | 'off'> = process
): Promise<number> {
  const { command, args, env } = desktopHostCommand(options, environment);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { env, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    signals.on('SIGTERM', onTerm);
    signals.on('SIGINT', onInt);
    const cleanup = () => {
      signals.off('SIGTERM', onTerm);
      signals.off('SIGINT', onInt);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1));
    });
  });
}
