import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  posixEnvFileContents,
  selectSessionMcpServers,
  tomlInlineStringTable,
  tomlString,
  tomlStringArray,
  wrapWithPosixEnvFile,
} from './session-mcp';

describe('selectSessionMcpServers', () => {
  it('keeps the first valid server per name and drops unsafe entries', () => {
    const valid = { name: 'orkestra-browser', command: '/node', args: ['a'] };
    expect(
      selectSessionMcpServers([
        valid,
        { name: 'orkestra-browser', command: '/other', args: [] },
        { name: 'has.dot', command: '/node', args: [] },
        { name: 'has space', command: '/node', args: [] },
        { name: 'empty-command', command: '', args: [] },
        { name: 'nul-arg', command: '/node', args: ['a\0b'] },
        { name: 'bad-env', command: '/node', args: [], env: { 'A-B': '1' } },
        { name: 'surrogate', command: '/node', args: ['\uD800'] },
        { name: 'ok_2', command: '/node', args: [], env: { TOKEN_1: 'x' } },
      ]).map((server) => server.name)
    ).toEqual(['orkestra-browser', 'ok_2']);
  });
});

describe('TOML values', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(tomlString('a"b\\c\nd\u007f\u0001é')).toBe('"a\\"b\\\\c\\u000ad\\u007f\\u0001é"');
    expect(tomlStringArray(['x', 'y z'])).toBe('["x","y z"]');
    expect(tomlInlineStringTable({ A: '1', 'B C': '"' })).toBe('{"A"="1","B C"="\\""}');
  });

  it('rejects lone surrogates instead of emitting invalid TOML', () => {
    expect(() => tomlString('\uDC00')).toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('POSIX env file wrapper', () => {
  it('loads quoted secrets from the file and execs the real command with its args', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orkestra-session-mcp-test-'));
    try {
      const envFile = join(directory, "server's env.env");
      const secret = `it's a "secret" $HOME \`id\` \\ \n second line`;
      writeFileSync(envFile, posixEnvFileContents({ ORKESTRA_TOOLS_TOKEN: secret, PLAIN: 'p' }), {
        mode: 0o600,
      });
      const launch = wrapWithPosixEnvFile(
        {
          command: process.execPath,
          args: [
            '-e',
            'process.stdout.write(JSON.stringify([process.env.ORKESTRA_TOOLS_TOKEN, process.env.PLAIN, process.argv.slice(1)]))',
            'arg with space',
            '$1',
          ],
        },
        envFile
      );
      expect(launch.command).toBe('/bin/sh');
      expect(launch.args.join(' ')).not.toContain('secret');

      const result = spawnSync(launch.command, launch.args, {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([secret, 'p', ['arg with space', '$1']]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
