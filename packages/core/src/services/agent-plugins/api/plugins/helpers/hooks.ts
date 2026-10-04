import { Buffer } from 'node:buffer';
import { quoteArg } from '#primitives/exec/api';

export type HookCommandOptions = {
  platform?: NodeJS.Platform;
  stdoutJson?: Record<string, unknown>;
};

export const ORKESTRA_MARKER = 'ORKESTRA_HOOK_PORT';
export const ORKESTRA_HOOK_CONFIG_VERSION = 1;
export const ORKESTRA_HOOK_VERSION_MARKER = `ORKESTRA_HOOK_CONFIG_VERSION=${ORKESTRA_HOOK_CONFIG_VERSION}`;
export const ORKESTRA_HOOK_POSIX_GUARD =
  'if [ -z "${ORKESTRA_HOOK_PORT:-}" ] || [ -z "${ORKESTRA_HOOK_NONCE:-}" ] || [ -z "${ORKESTRA_PTY_ID:-}" ]; then exit 0; fi';

/** Filter out orkestra-managed entries from a hook array. */
export function filterUserHooks<T>(entries: T[], stringify?: (entry: T) => string): T[] {
  const toStr = stringify ?? JSON.stringify;
  return entries.filter((entry) => !toStr(entry).includes(ORKESTRA_MARKER));
}

// ── Internal helpers ────────────────────────────────────────────────────────

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type HookPostPayload = 'stdin' | { json: Record<string, string> };

function makePosixHookPostCommand(eventType: string, payload: HookPostPayload): string {
  const payloadPart =
    payload === 'stdin' ? '-d @- ' : `--data-binary '${JSON.stringify(payload.json)}' `;
  return (
    `${ORKESTRA_HOOK_VERSION_MARKER}; ${ORKESTRA_HOOK_POSIX_GUARD}; curl -sf -X POST ` +
    '-H "Content-Type: application/json" ' +
    '-H "X-Orkestra-Token: $ORKESTRA_HOOK_NONCE" ' +
    '-H "X-Orkestra-Pty-Id: $ORKESTRA_PTY_ID" ' +
    `-H "X-Orkestra-Event-Type: ${eventType}" ` +
    payloadPart +
    '"http://127.0.0.1:$ORKESTRA_HOOK_PORT/hook" || true'
  );
}

function makeWindowsHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  stdoutJson?: Record<string, unknown>
): string {
  const bodyLine =
    payload === 'stdin'
      ? '$payload = [Console]::In.ReadToEnd()'
      : `$payload = ${quotePowerShellString(JSON.stringify((payload as { json: Record<string, string> }).json))}`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'if (-not $env:ORKESTRA_HOOK_PORT -or -not $env:ORKESTRA_HOOK_NONCE -or -not $env:ORKESTRA_PTY_ID) { exit 0 }',
    bodyLine,
    'try { Invoke-WebRequest -UseBasicParsing -Method POST ' +
      "-Uri ('http://127.0.0.1:' + $env:ORKESTRA_HOOK_PORT + '/hook') " +
      '-Headers @{ ' +
      "'Content-Type' = 'application/json'; " +
      "'X-Orkestra-Token' = $env:ORKESTRA_HOOK_NONCE; " +
      "'X-Orkestra-Pty-Id' = $env:ORKESTRA_PTY_ID; " +
      `'X-Orkestra-Event-Type' = '${eventType}' ` +
      '} -Body $payload | Out-Null } catch { exit 0 }',
  ].join('; ');
  return makeWindowsPowerShellHookCommand(
    stdoutJson === undefined
      ? script
      : `try { ${script} } finally { [Console]::Out.WriteLine(${quotePowerShellString(JSON.stringify(stdoutJson))}) }`
  );
}

export function makeWindowsPowerShellHookCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // A silent `set` no-op embeds both markers so hook-config cleanup can find
  // our entries. No `>NUL`: an outer shell (Git Bash/PowerShell) parses the
  // redirect before cmd.exe and creates a real `NUL` file. No quotes either —
  // they break when the body is re-wrapped in `cmd.exe /c`. Markers go in the
  // value, not the var name, so they can't shadow ORKESTRA_HOOK_PORT/NONCE/PTY_ID.
  return (
    `cmd.exe /d /c set ORKESTRA_HOOK_MARKER=${ORKESTRA_HOOK_VERSION_MARKER} ${ORKESTRA_MARKER}&&` +
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  );
}

/** Post an event with an arbitrary payload, platform-aware. */
export function makeHookPostCommand(
  eventType: string,
  payload: HookPostPayload,
  opts: HookCommandOptions
): string {
  if ((opts.platform ?? process.platform) === 'win32') {
    return makeWindowsHookPostCommand(eventType, payload, opts.stdoutJson);
  }
  const command = makePosixHookPostCommand(eventType, payload);
  return opts.stdoutJson === undefined
    ? command
    : `( ${command} ) >/dev/null; printf '%s\\n' ${quoteArg(JSON.stringify(opts.stdoutJson), 'posix')}`;
}

// ── Public command builders ─────────────────────────────────────────────────

/**
 * Standard stdin-piped hook command.
 * The agent pipes the event JSON body through stdin.
 */
export function makeStdinHookCommand(eventType: string, opts: HookCommandOptions = {}): string {
  return makeHookPostCommand(eventType, 'stdin', opts);
}

/**
 * Fixed-body notification hook command.
 * Sends a JSON body with a `notification_type` key (used by Codex-style events).
 */
export function makeNotificationHookCommand(
  notificationType: 'idle_prompt' | 'permission_prompt',
  opts: HookCommandOptions = {}
): string {
  return makeHookPostCommand(
    'notification',
    { json: { notification_type: notificationType } },
    opts
  );
}
