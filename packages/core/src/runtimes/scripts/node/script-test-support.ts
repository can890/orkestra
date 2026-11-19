import { spawn } from 'node:child_process';
import { toChildProcessLaunch } from '#primitives/exec/node';
import {
  normalizeSignal,
  type PtyExitInfo,
  type PtyProcess,
  type PtySpawner,
  type PtySpawnSpec,
} from '#services/pty/api';

const WINDOWS = process.platform === 'win32';

/**
 * Test-only spawner: executes the spec through plain child processes instead of a
 * native PTY, so contract tests can run real shell scripts without node-pty. Output
 * is stdout+stderr interleaved; resize is a no-op.
 *
 * Exit is reported like a PTY reports it — only after the output drained (node-pty
 * holds its exit event until the socket closed). The scripts runtime settles a run
 * on exit and folds the output tail into that settlement, so an exit that overtakes
 * the last chunks loses them.
 */
export class ChildProcessPtySpawner implements PtySpawner {
  spawn(spec: PtySpawnSpec): PtyProcess {
    const launch = toChildProcessLaunch(spec.invocation);
    const child = spawn(launch.executable, launch.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      // Own process group, so kill reaches the script's whole tree (see kill below).
      detached: !WINDOWS,
    });
    const dataHandlers: Array<(data: string) => void> = [];
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const emit = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const handler of dataHandlers) handler(text);
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    let exited = false;
    const emitExit = (info: PtyExitInfo) => {
      if (exited) return;
      exited = true;
      for (const handler of exitHandlers) handler(info);
    };
    // 'close', not 'exit': 'exit' can fire while the last chunks are still unread in
    // the pipes; 'close' fires once both streams ended.
    child.on('close', (code, signal) => {
      emitExit({ exitCode: code, signal: normalizeSignal(signal) ?? null });
    });
    child.on('error', () => emitExit({ exitCode: 1, signal: null }));
    return {
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        try {
          // Signal the group, not just the shell: a surviving grandchild (`sleep`
          // under `sh -c`) keeps the pipes open and would hold 'close' back.
          if (WINDOWS || child.pid === undefined) child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {}
      },
      onData: (handler) => dataHandlers.push(handler),
      onExit: (handler) => exitHandlers.push(handler),
      getPid: () => child.pid ?? -1,
    };
  }
}
