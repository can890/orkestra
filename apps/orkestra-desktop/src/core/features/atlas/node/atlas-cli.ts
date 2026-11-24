import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '@orkestra/shared';
import {
  ATLAS_LIMITS,
  cleanCliOutput,
  type AtlasError,
} from '@core/features/atlas/api/atlas-model';

export type AtlasRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Çalıştırılabilir dosya bulunamadı (ENOENT/EACCES). */
  notFound: boolean;
};

export type AtlasRunOptions = {
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
};

/** Enjekte edilen süreç çalıştırıcı; testler sahte `atlas` betiğiyle çalışır. */
export type AtlasRunner = (
  executable: string,
  args: readonly string[],
  options: AtlasRunOptions
) => Promise<AtlasRunResult>;

const MAX_BUFFER = 4 * 1024 * 1024;

/** Kabuk yok: argv dizisi; stdin yalnızca verilen metin. */
export const nodeAtlasRunner: AtlasRunner = (executable, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = failure?.code;
        resolve({
          exitCode: failure ? (typeof code === 'number' ? code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: failure?.killed === true,
          notFound: code === 'ENOENT' || code === 'EACCES',
        });
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });

/**
 * Finder'dan açılan uygulamanın PATH'i kısa olabilir; kullanıcı araçlarının olağan dizinleri
 * de eklenir.
 */
export function atlasSearchPath(env: NodeJS.ProcessEnv, home = homedir()): string[] {
  const extra = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const fromEnv = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return [...new Set([...extra, ...fromEnv])];
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ayardaki yol (mutlak olmalı) ya da arama yolundaki ilk çalıştırılabilir `atlas`. */
export async function resolveAtlasExecutable(input: {
  configured: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const exists = input.exists ?? isExecutable;
  const configured = input.configured.trim();
  if (configured) {
    return isAbsolute(configured) && (await exists(configured)) ? configured : null;
  }
  for (const dir of atlasSearchPath(input.env, input.home)) {
    const candidate = join(dir, 'atlas');
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export type AtlasCliDeps = {
  runner: AtlasRunner;
  /** Her çağrıda yeniden çözülür (ayar değişebilir). */
  resolveExecutable(): Promise<string | null>;
  /** Alt süreç ortamı (kullanıcının kabuk ortamı + genişletilmiş PATH). */
  env(): NodeJS.ProcessEnv;
};

export type AtlasDetection = {
  available: boolean;
  executable: string | null;
  message: string | null;
};

export type AtlasCardInput = {
  text: string;
  tags: readonly string[];
  agent: string;
  session?: string;
  project?: string;
};

const SEARCH_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 8_000;

/**
 * `atlas` CLI üzerinde ince sarmalayıcı. Yalnızca şu alt komutları çalıştırır: `--help`
 * (algılama), `ara` ve `gecmis` (salt okunur) ve `kart` (yazma; yalnızca kart akışından).
 * Kullanıcı girdisi her zaman `--` ayracından sonra konumsal argüman ya da `--ad=değer`
 * biçiminde verilir; bayrak olarak yorumlanamaz.
 */
export class AtlasCli {
  constructor(private readonly deps: AtlasCliDeps) {}

  async detect(): Promise<AtlasDetection> {
    const executable = await this.deps.resolveExecutable();
    if (!executable) {
      return {
        available: false,
        executable: null,
        message: 'The atlas CLI was not found on PATH or in ~/.local/bin.',
      };
    }
    const result = await this.deps.runner(executable, ['--help'], {
      timeoutMs: DETECT_TIMEOUT_MS,
      env: this.deps.env(),
    });
    if (result.exitCode !== 0) {
      return {
        available: false,
        executable,
        message: firstLine(result.stderr) ?? 'atlas --help failed.',
      };
    }
    return { available: true, executable, message: null };
  }

  search(query: string, limit: number): Promise<Result<string, AtlasError>> {
    return this.read(['ara', '--limit', String(limit), '--', query]);
  }

  history(project: string, count = 10): Promise<Result<string, AtlasError>> {
    return this.read(['gecmis', '--adet', String(count), '--', project]);
  }

  async writeCard(input: AtlasCardInput): Promise<Result<void, AtlasError>> {
    const executable = await this.deps.resolveExecutable();
    if (!executable) return err(cliMissing());
    const args = ['kart', `--etiket=${input.tags.join(',')}`, `--ajan=${input.agent}`];
    if (input.session) args.push(`--oturum=${input.session}`);
    if (input.project) args.push(`--proje=${input.project}`);
    const result = await this.deps.runner(executable, args, {
      stdin: input.text,
      timeoutMs: WRITE_TIMEOUT_MS,
      env: this.deps.env(),
    });
    const failure = toFailure(result);
    return failure ? err(failure) : ok(undefined);
  }

  private async read(args: string[]): Promise<Result<string, AtlasError>> {
    const executable = await this.deps.resolveExecutable();
    if (!executable) return err(cliMissing());
    const result = await this.deps.runner(executable, args, {
      timeoutMs: SEARCH_TIMEOUT_MS,
      env: this.deps.env(),
    });
    const failure = toFailure(result);
    if (failure) return err(failure);
    return ok(cleanCliOutput(result.stdout, ATLAS_LIMITS.maxOutputChars));
  }
}

function cliMissing(): AtlasError {
  return { code: 'cli-missing', message: 'The atlas CLI is not installed or not executable.' };
}

function toFailure(result: AtlasRunResult): AtlasError | null {
  if (result.notFound) return cliMissing();
  if (result.timedOut) return { code: 'timeout', message: 'The atlas CLI timed out.' };
  if (result.exitCode !== 0) {
    const detail = firstLine(cleanCliOutput(result.stderr || result.stdout, 400));
    return {
      code: 'failed',
      message: `atlas exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}`,
    };
  }
  return null;
}

function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 300) : null;
}
