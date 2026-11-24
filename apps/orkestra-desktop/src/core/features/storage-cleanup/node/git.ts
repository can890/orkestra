import { execFile } from 'node:child_process';

export type GitResult = { code: number; stdout: string; stderr: string };

/** Temizliğin git çağrıları: hiçbir zaman fırlatmaz, çıkış kodunu döner. */
export type CleanupGit = (cwd: string, args: readonly string[]) => Promise<GitResult>;

const MAX_OUTPUT = 16 * 1024 * 1024;

/** Etkileşimsiz, C yerelli, isteğe bağlı kilit almayan git çalıştırıcı. */
export function createCleanupGit(env: NodeJS.ProcessEnv = process.env): CleanupGit {
  return (cwd, args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        [...args],
        {
          cwd,
          env: {
            ...env,
            LC_ALL: 'C',
            LANG: 'C',
            LANGUAGE: 'C',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
          },
          maxBuffer: MAX_OUTPUT,
          timeout: 120_000,
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                ? ((error as unknown as { code: number }).code ?? 1)
                : 1;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      );
    });
}
