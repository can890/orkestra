// Gerçek makine bağımlılıkları: `service` ve `policy` komutlarının üretim bağlamı. Testler bu
// dosyayı kullanmaz; sahte runner ve geçici ev dizini enjekte eder.
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DEFAULT_WORKSPACE_SERVER_SOCKET_PATH } from '../daemon/paths';
import { statusDaemon } from '../daemon/status';
import type { CommandRunner, ServiceCliDeps } from './service-cli';

const LAUNCHER_NAME = 'orkestra-workspace-server';

export const execRunner: CommandRunner = (command, args) =>
  new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? (error as unknown as { code: number }).code
              : 127;
        resolvePromise({
          code,
          stdout: String(stdout),
          stderr: String(stderr || error?.message || ''),
        });
      }
    );
  });

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function whichOnPath(
  name: string,
  envPath = process.env.PATH ?? ''
): Promise<string | null> {
  for (const directory of envPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Servisin çalıştıracağı CLI. Paketli kurulumda (`~/.orkestra/workspace-server/versions/<v>`)
 * `current` bağlantısı kullanılır: yeni bir sürüm kurulunca servis yeniden başlatıldığında onu
 * çalıştırır (yerinde yükseltme). Kaynaktan çalışırken `node <dist/index.mjs>` kullanılır.
 */
export async function resolveCliProgram(options: {
  entryPath: string;
  execPath: string;
  homeDirectory: string;
}): Promise<string[]> {
  const entry = resolve(options.entryPath);
  const launcher = join(dirname(entry), '..', 'bin', LAUNCHER_NAME);
  if (await isExecutable(launcher)) {
    const root = join(options.homeDirectory, '.orkestra', 'workspace-server');
    const versions = `${join(root, 'versions')}/`;
    const current = join(root, 'current', 'bin', LAUNCHER_NAME);
    if (resolve(launcher).startsWith(versions) && (await isExecutable(current))) return [current];
    return [resolve(launcher)];
  }
  return [options.execPath, entry];
}

export async function createNodeServiceDeps(): Promise<ServiceCliDeps> {
  const home = homedir();
  return {
    platform: process.platform,
    homeDirectory: home,
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    uid: process.getuid?.() ?? 0,
    username: userInfo().username,
    run: execRunner,
    cliProgram: await resolveCliProgram({
      entryPath: process.argv[1] ?? '',
      execPath: process.execPath,
      homeDirectory: home,
    }),
    cliVersion: currentCliVersion(),
    which: (name) => whichOnPath(name),
    defaultSocketPath: DEFAULT_WORKSPACE_SERVER_SOCKET_PATH,
    probeServerVersion: async (socketPath) => {
      const result = await statusDaemon(socketPath);
      return result.success ? result.data.health.version : null;
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export function currentCliVersion(): string {
  return process.env.ORKESTRA_WS_APP_VERSION || process.env.npm_package_version || 'unknown';
}
