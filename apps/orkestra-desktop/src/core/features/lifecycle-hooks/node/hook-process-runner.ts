import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { resolveLocalPtySpawn } from '@orkestra/core/services/pty/api';

export type HookProcessRequest = Readonly<{
  /** Kullanıcının yazdığı komut; olduğu gibi çalışır. */
  command: string;
  shellSetup?: string;
  env: Record<string, string>;
  /** Olay verisi: yalnızca stdin'e yazılır. */
  stdin: string;
  timeoutMs: number;
}>;

export type HookProcessResult = Readonly<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Kırpılmış kuyruk (maskeleme çağıranın işidir). */
  stdout: string;
  stderr: string;
  /** Süreç hiç başlatılamadıysa neden. */
  spawnError?: string;
}>;

/** Enjekte edilebilir süreç çalıştırıcı. Asla fırlatmaz; sonuç her zaman döner. */
export type HookProcessRunner = (request: HookProcessRequest) => Promise<HookProcessResult>;

const OUTPUT_TAIL_CHARS = 8_000;
const KILL_GRACE_MS = 2_000;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_CHARS ? next.slice(next.length - OUTPUT_TAIL_CHARS) : next;
}

function killTree(child: ChildProcess, platform: NodeJS.Platform, signal: 'SIGTERM' | 'SIGKILL') {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      // Kendi süreç grubunda başlatıldı: kabuğun çocukları da sonlanır.
      process.kill(-pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Süreç zaten bitmiş olabilir.
    }
  }
}

/**
 * Yerel süreç çalıştırıcı: komut satırı mevcut PTY spawn planlayıcısıyla (`shellSetup &&
 * komut`) kabuk argv'sine çevrilir; çalışma dizini kullanıcının ev dizinidir. Zaman aşımı
 * dolunca süreç ağacı sonlandırılır.
 */
export function createLocalHookProcessRunner(
  options: { platform?: NodeJS.Platform; cwd?: string } = {}
): HookProcessRunner {
  const platform = options.platform ?? process.platform;
  return (request) =>
    new Promise<HookProcessResult>((resolve) => {
      let settled = false;
      const finish = (result: HookProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve(result);
      };
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      let child: ChildProcess;
      try {
        const cwd = options.cwd ?? os.homedir();
        const resolved = resolveLocalPtySpawn({
          intent: {
            kind: 'run-command',
            cwd,
            command: { kind: 'shell-line', commandLine: request.command },
            shellSetup: request.shellSetup || undefined,
          },
          platform,
          env: request.env,
        });
        const { invocation } = resolved;
        const spawnOptions = {
          cwd,
          env: request.env,
          stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: platform !== 'win32',
        };
        child =
          invocation.kind === 'argv'
            ? spawn(invocation.executable, [...invocation.argv], spawnOptions)
            : spawn(invocation.executable, [invocation.rawArguments], {
                ...spawnOptions,
                windowsVerbatimArguments: true,
              });
      } catch (error) {
        finish({
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = appendTail(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendTail(stderr, chunk);
      });
      // Komut stdin'i okumadan çıkarsa EPIPE gelir; bu bir hata değildir.
      child.stdin?.on('error', () => {});
      child.stdin?.end(request.stdin);

      child.on('error', (error) => {
        finish({
          exitCode: null,
          signal: null,
          timedOut,
          stdout,
          stderr,
          spawnError: error.message,
        });
      });
      child.on('close', (code, signal) => {
        finish({ exitCode: code, signal, timedOut, stdout, stderr });
      });

      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, platform, 'SIGTERM');
        killTimer = setTimeout(() => killTree(child, platform, 'SIGKILL'), KILL_GRACE_MS);
        // SIGKILL sonrası bile 'close' gelmezse (ör. kalıtılmış açık borular) sonucu yine ver.
        killTimer.unref?.();
        setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL', timedOut, stdout, stderr }), KILL_GRACE_MS + 1_000).unref?.();
      }, request.timeoutMs);
    });
}
