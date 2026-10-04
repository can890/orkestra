import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ORKESTRA_MARKER,
  ORKESTRA_HOOK_VERSION_MARKER,
  filterUserHooks,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
} from './hooks';

describe('hook command helpers', () => {
  it('builds POSIX stdin hook commands', () => {
    expect(makeStdinHookCommand('stop', { platform: 'linux' })).toBe(
      `${ORKESTRA_HOOK_VERSION_MARKER}; ` +
        'if [ -z "${ORKESTRA_HOOK_PORT:-}" ] || [ -z "${ORKESTRA_HOOK_NONCE:-}" ] || [ -z "${ORKESTRA_PTY_ID:-}" ]; then exit 0; fi; ' +
        'curl -sf -X POST ' +
        '-H "Content-Type: application/json" ' +
        '-H "X-Orkestra-Token: $ORKESTRA_HOOK_NONCE" ' +
        '-H "X-Orkestra-Pty-Id: $ORKESTRA_PTY_ID" ' +
        '-H "X-Orkestra-Event-Type: stop" ' +
        '-d @- ' +
        '"http://127.0.0.1:$ORKESTRA_HOOK_PORT/hook" || true'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not invoke curl when the Orkestra hook environment is absent',
    () => {
      const command = makeStdinHookCommand('stop', { platform: 'linux' });
      const shellCommand = `curl() { printf called; }; ${command}`;

      const outsideOrkestra = spawnSync('/bin/sh', ['-c', shellCommand], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
        input: '{}',
      });
      const insideOrkestra = spawnSync('/bin/sh', ['-c', shellCommand], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          ORKESTRA_HOOK_PORT: '1234',
          ORKESTRA_HOOK_NONCE: 'nonce',
          ORKESTRA_PTY_ID: 'pty-1',
        },
        input: '{}',
      });

      expect(outsideOrkestra.status).toBe(0);
      expect(outsideOrkestra.stdout).toBe('');
      expect(insideOrkestra.status).toBe(0);
      expect(insideOrkestra.stdout).toBe('called');
    }
  );

  it('builds Windows hook commands without a quoted cmd.exe body', () => {
    const command = makeNotificationHookCommand('idle_prompt', { platform: 'win32' });

    expect(command).toMatch(
      /^cmd\.exe \/d \/c set ORKESTRA_HOOK_MARKER=ORKESTRA_HOOK_CONFIG_VERSION=1 ORKESTRA_HOOK_PORT&&powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$/
    );
    expect(command).toContain(ORKESTRA_MARKER);
    expect(command).not.toContain('/c "');
    expect(command).not.toContain('& powershell.exe');
  });

  it('emits no redirects (an outer shell parsing >NUL creates a stray NUL file)', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');

    expect(command).not.toContain('>');
  });

  it.skipIf(process.platform === 'win32')(
    'returns safely quoted JSON when transport fails or routing variables are absent',
    () => {
      const response = {
        decision: 'stop',
        reason: "don't run $(printf injected) or `echo injected`",
      };
      const command = makeStdinHookCommand('stop', {
        platform: 'linux',
        stdoutJson: response,
      });
      for (const env of [
        {},
        { ORKESTRA_HOOK_PORT: '1234', ORKESTRA_HOOK_NONCE: 'nonce', ORKESTRA_PTY_ID: 'pty-1' },
      ]) {
        const result = spawnSync(
          '/bin/sh',
          ['-c', `curl() { printf 'unexpected server response'; return 22; }; ${command}`],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, input: '{}' }
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(response);
      }
    }
  );

  it('keeps the Orkestra markers visible to hook config cleanup without PowerShell args', () => {
    const command = makeWindowsPowerShellHookCommand('Write-Output "ok"');

    expect(
      command.startsWith(
        `cmd.exe /d /c set ORKESTRA_HOOK_MARKER=${ORKESTRA_HOOK_VERSION_MARKER} ${ORKESTRA_MARKER}&&powershell.exe `
      )
    ).toBe(true);
    expect(filterUserHooks([{ command }])).toHaveLength(0);
  });
});
