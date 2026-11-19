import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRunner, ScratchFiles } from './computer-desktop';

const MAX_BUFFER = 64 * 1024 * 1024;

/** Gerçek süreç çalıştırıcı: kabuk yok, argv dizisi, stdin yalnızca verilen JSON. */
export const nodeProcessRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      { encoding: 'buffer', timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          exitCode: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr),
          timedOut: failure?.killed === true,
        });
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });

/** Her görüntü için 0700 yetkili ayrı bir geçici dizin; okunduktan sonra silinir. */
export const tmpScratchFiles: ScratchFiles = {
  async create(extension) {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-computer-'));
    const path = join(directory, `capture.${extension}`);
    return {
      path,
      read: () => readFile(path),
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  },
};
