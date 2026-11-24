// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/provider-acp-registry/src/server/AcpRegistrySupport.ts
// Registry dağıtımlarını Orkestra'nın uygulama veri dizinine kurar:
// - binary: yalnızca kayıtta bildirilen HTTPS adresinden indirir, varsa SHA-256 doğrular, arşiv
//   girdilerini kök dışına çıkmaya karşı denetler ve çıkarır. Hiçbir şey çalıştırılmaz.
// - npx: `npm install --global --prefix <dizin> paket@sürüm` (kesin sürüm).
// - uvx: `uv tool install` (UV_TOOL_DIR/UV_TOOL_BIN_DIR Orkestra dizinine).
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  archiveKind,
  normalizeRegistryCommandPath,
  parseNpxPackageSpec,
  parseUvxPackageSpec,
  validateArchiveEntries,
  versionDirectoryName,
  type ResolvedAcpRegistryDistribution,
} from '../api/distribution';
import type { AcpRegistryAgent } from '../api/registry-schema';
import type { AcpRegistryErrorReason } from '../api/schemas';
import type { FetchLike } from './registry-client';

export { findExecutable } from '../api/node/find-executable';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1_000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;

export class AcpInstallError extends Error {
  constructor(
    readonly reason: AcpRegistryErrorReason,
    message: string
  ) {
    super(message);
  }
}

export type RunResult = { code: number | null; stdout: string; stderr: string };
export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
) => Promise<RunResult>;

export type InstallResult = {
  /** Ajanı başlatan mutlak çalıştırılabilir yolu. */
  command: string;
  /** Orkestra'nın yönettiği kurulum kökü (kaldırırken silinir). */
  installDir: string;
};

export type AcpRegistryInstallerOptions = {
  toolsDir: string;
  fetch: FetchLike;
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** Kurulum komutlarının ortamı (kullanıcı kabuk ortamı). */
  env?: () => Promise<Record<string, string>>;
};

export function agentVersionRoot(toolsDir: string, agentId: string, version: string): string {
  return join(toolsDir, agentId, versionDirectoryName(version));
}

/** Kurulum komutunu kullanıcıya göstermek için (plan). */
export function packageInstallCommand(
  distribution: ResolvedAcpRegistryDistribution,
  installRoot: string
): string[] | null {
  if (distribution.kind === 'npx' && distribution.packageSpec) {
    return [
      'npm',
      'install',
      '--global',
      '--prefix',
      join(installRoot, 'npm'),
      '--no-fund',
      '--no-audit',
      distribution.packageSpec,
    ];
  }
  if (distribution.kind === 'uvx' && distribution.packageSpec) {
    return ['uv', 'tool', 'install', '--force', distribution.packageSpec];
  }
  return null;
}

export class AcpRegistryInstaller {
  private readonly platform: NodeJS.Platform;
  private readonly run: RunCommand;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly options: AcpRegistryInstallerOptions) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
  }

  /** Aynı ajan için kurulumları sıraya koyar. */
  install(
    agent: AcpRegistryAgent,
    distribution: ResolvedAcpRegistryDistribution
  ): Promise<InstallResult> {
    const previous = this.locks.get(agent.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        distribution.kind === 'binary'
          ? this.installBinary(agent, distribution)
          : this.installPackage(agent, distribution)
      );
    this.locks.set(agent.id, next);
    return next;
  }

  async installBinary(
    agent: AcpRegistryAgent,
    distribution: ResolvedAcpRegistryDistribution
  ): Promise<InstallResult> {
    const target = distribution.binaryTarget;
    const platformTarget = distribution.platformTarget;
    if (!target || !platformTarget) {
      throw new AcpInstallError(
        'unsupported_platform',
        `${agent.id} has no binary for this platform.`
      );
    }
    const segments = normalizeRegistryCommandPath(target.cmd);
    if (!segments) {
      throw new AcpInstallError(
        'archive_invalid',
        `${agent.id} declares an unsafe command path '${target.cmd}'.`
      );
    }
    const versionRoot = agentVersionRoot(this.options.toolsDir, agent.id, agent.version);
    const installRoot = join(versionRoot, platformTarget);
    const executable = join(installRoot, ...segments);
    if (await exists(executable)) {
      return {
        command: await assertExecutableInRoot(installRoot, executable, this.platform),
        installDir: versionRoot,
      };
    }

    await mkdir(versionRoot, { recursive: true });
    const staging = join(versionRoot, `.install-${randomUUID()}`);
    const extractionRoot = join(staging, 'extracted');
    await mkdir(extractionRoot, { recursive: true });
    try {
      const kind = archiveKind(target.archive);
      const archivePath = join(staging, kind === 'raw' ? 'agent.bin' : `agent.${kind}`);
      const digest = await downloadVerified(this.options.fetch, target.archive, archivePath);
      if (target.sha256 && digest !== target.sha256.toLowerCase()) {
        throw new AcpInstallError(
          'checksum_mismatch',
          `${agent.id} download did not match its declared SHA-256 (expected ${target.sha256.toLowerCase()}, got ${digest}).`
        );
      }
      if (kind === 'raw') {
        const destination = join(extractionRoot, ...segments);
        await mkdir(dirname(destination), { recursive: true });
        await rename(archivePath, destination);
      } else {
        await this.extractArchive(kind, archivePath, extractionRoot, agent.id);
      }
      const staged = join(extractionRoot, ...segments);
      if (!(await exists(staged))) {
        throw new AcpInstallError(
          'archive_invalid',
          `${agent.id} archive did not contain '${target.cmd}'.`
        );
      }
      await assertExecutableInRoot(extractionRoot, staged, this.platform, { makeExecutable: true });
      await rm(installRoot, { recursive: true, force: true });
      await rename(extractionRoot, installRoot);
      return {
        command: await assertExecutableInRoot(installRoot, executable, this.platform),
        installDir: versionRoot,
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractArchive(
    kind: 'tar_gz' | 'tar_bz2' | 'zip',
    archivePath: string,
    destination: string,
    agentId: string
  ): Promise<void> {
    const useUnzip = kind === 'zip' && this.platform !== 'win32';
    const listing = useUnzip
      ? await this.checked('unzip', ['-Z1', archivePath], 'archive_invalid')
      : await this.checked(
          'tar',
          [kind === 'tar_gz' ? '-tzf' : kind === 'tar_bz2' ? '-tjf' : '-tf', archivePath],
          'archive_invalid'
        );
    if (!validateArchiveEntries(listing)) {
      throw new AcpInstallError('archive_invalid', `${agentId} archive contains an unsafe path.`);
    }
    if (useUnzip) {
      await this.checked('unzip', ['-q', archivePath, '-d', destination], 'archive_invalid');
    } else {
      const flag = kind === 'tar_gz' ? '-xzf' : kind === 'tar_bz2' ? '-xjf' : '-xf';
      await this.checked('tar', [flag, archivePath, '-C', destination], 'archive_invalid');
    }
  }

  async installPackage(
    agent: AcpRegistryAgent,
    distribution: ResolvedAcpRegistryDistribution
  ): Promise<InstallResult> {
    const spec = distribution.packageSpec;
    if (!spec) throw new AcpInstallError('unsupported_distribution', `${agent.id} has no package.`);
    const versionRoot = agentVersionRoot(this.options.toolsDir, agent.id, agent.version);
    const env = withoutNpmPrefix((await this.options.env?.()) ?? stringEnv(process.env));
    if (distribution.kind === 'npx') {
      const prefix = join(versionRoot, 'npm');
      await mkdir(prefix, { recursive: true });
      const command = packageInstallCommand(distribution, versionRoot)!;
      await this.checked(command[0]!, command.slice(1), 'install_failed', {
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
        missingRunner: 'npm',
      });
      const executable = await resolveNpmBin(prefix, spec, agent.id, this.platform);
      if (!executable) {
        throw new AcpInstallError(
          'install_failed',
          `Installed ${spec}, but could not find its command.`
        );
      }
      return { command: executable, installDir: versionRoot };
    }
    const toolDir = join(versionRoot, 'python');
    const binDir = join(toolDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await this.checked('uv', ['tool', 'install', '--force', spec], 'install_failed', {
      env: { ...env, UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir },
      timeoutMs: INSTALL_TIMEOUT_MS,
      missingRunner: 'uv',
    });
    const name = parseUvxPackageSpec(spec).name;
    for (const candidate of packageCommandCandidates(agent.id, name)) {
      const path = join(binDir, this.platform === 'win32' ? `${candidate}.exe` : candidate);
      if (await exists(path)) return { command: path, installDir: versionRoot };
    }
    throw new AcpInstallError(
      'install_failed',
      `Installed ${spec}, but could not find its command.`
    );
  }

  private async checked(
    command: string,
    args: string[],
    reason: AcpRegistryErrorReason,
    options: { env?: Record<string, string>; timeoutMs?: number; missingRunner?: string } = {}
  ): Promise<string> {
    let result: RunResult;
    try {
      result = await this.run(command, args, { env: options.env, timeoutMs: options.timeoutMs });
    } catch (error) {
      if (options.missingRunner && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AcpInstallError(
          'runner_unavailable',
          `'${options.missingRunner}' is required to install this agent but was not found on PATH.`
        );
      }
      throw new AcpInstallError(reason, `Could not run '${command}': ${(error as Error).message}`);
    }
    if (result.code !== 0) {
      throw new AcpInstallError(
        reason,
        `'${command}' exited with code ${result.code}: ${result.stderr.trim().slice(-1_000)}`
      );
    }
    return result.stdout;
  }
}

/** İndirmeyi akış halinde dosyaya yazar ve SHA-256 özetini döndürür. */
export async function downloadVerified(
  fetch: FetchLike,
  url: string,
  destination: string,
  maxBytes = MAX_ARCHIVE_BYTES
): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new AcpInstallError('download_failed', 'Agent downloads must use HTTPS.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    } catch (error) {
      throw new AcpInstallError(
        'download_failed',
        `Could not download ${url}: ${(error as Error).message}`
      );
    }
    if (!response.ok || !response.body) {
      throw new AcpInstallError('download_failed', `Download failed with HTTP ${response.status}.`);
    }
    const hash = createHash('sha256');
    const out = createWriteStream(destination, { mode: 0o600 });
    let total = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new AcpInstallError('archive_invalid', `Download exceeds ${maxBytes} bytes.`);
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    }
    return hash.digest('hex');
  } finally {
    clearTimeout(timer);
  }
}

async function assertExecutableInRoot(
  root: string,
  executable: string,
  platform: NodeJS.Platform,
  options: { makeExecutable?: boolean } = {}
): Promise<string> {
  const rootReal = await realpath(root);
  const executableReal = await realpath(executable);
  const rel = relative(rootReal, executableReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AcpInstallError(
      'archive_invalid',
      'Agent command resolves outside its installation directory.'
    );
  }
  // chmod sembolik bağı izler; yalnızca gerçek yol kökün içindeyse çalıştırılabilir yap.
  if (options.makeExecutable && platform !== 'win32') await chmod(executableReal, 0o755);
  const info = await stat(executableReal);
  if (!info.isFile() || (platform !== 'win32' && (info.mode & 0o111) === 0)) {
    throw new AcpInstallError('archive_invalid', 'Agent command is not a regular executable file.');
  }
  return executable;
}

function packageCommandCandidates(agentId: string, packageName: string): string[] {
  const unscoped = packageName.split('/').pop() ?? packageName;
  return [...new Set([agentId, unscoped, unscoped.replace(/-acp$/u, '')])].filter((name) =>
    /^[a-z0-9][a-z0-9._-]*$/iu.test(name)
  );
}

/** npm genel kurulumunun bin komutunu paket manifestinden bulur (T3 `npmCommandName`). */
export async function resolveNpmBin(
  prefix: string,
  spec: string,
  agentId: string,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const { name, version } = parseNpxPackageSpec(spec);
  const root =
    platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(root, ...name.split('/'), 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (manifest.name !== name || manifest.version !== version) return undefined;
  const base = name.split('/').pop() ?? name;
  let command: string | undefined;
  if (typeof manifest.bin === 'string') command = base;
  else if (manifest.bin && typeof manifest.bin === 'object') {
    const entries = Object.entries(manifest.bin as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    if (entries.length === 1) command = entries[0]![0];
    else if (base in (manifest.bin as object)) command = base;
    else if (agentId in (manifest.bin as object)) command = agentId;
    else if (new Set(entries.map(([, target]) => target)).size === 1) command = entries[0]?.[0];
  }
  if (!command || !/^[a-z0-9@][a-z0-9._-]*$/iu.test(command)) return undefined;
  const binDir = platform === 'win32' ? prefix : join(prefix, 'bin');
  const executable = join(binDir, platform === 'win32' ? `${command}.cmd` : command);
  return (await exists(executable)) ? executable : undefined;
}

function withoutNpmPrefix(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== 'npm_config_prefix')
  );
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Kabuksuz argv çalıştırma; çıktı sınırlı. */
export const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_COMMAND_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
