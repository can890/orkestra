import { describe, expect, it } from 'vitest';
import { provider } from './index';
import { buildClaudeSessionMcp } from './session-mcp';

const ctx = { platform: 'linux' as const, filePath: (name: string) => `/tmp/cfg dir/${name}` };
const server = {
  name: 'orkestra-browser',
  command: '/usr/bin/node',
  args: ['/bridge.js'],
  env: { ORKESTRA_TOOLS_TOKEN: 'secret-token', ELECTRON_RUN_AS_NODE: '1' },
};

describe('buildClaudeSessionMcp', () => {
  it('passes one --mcp-config=<file> argument and keeps env in the file', () => {
    const launch = buildClaudeSessionMcp([server], ctx);
    // `=` biçimi değişken değerli bayrağın ilk istemi yutmasını önler.
    expect(launch.args).toEqual(['--mcp-config=/tmp/cfg dir/claude-mcp.json']);
    expect(launch.args.join(' ')).not.toContain('secret-token');
    expect(launch.files).toHaveLength(1);
    expect(launch.files[0]!.name).toBe('claude-mcp.json');
    expect(JSON.parse(launch.files[0]!.contents)).toEqual({
      mcpServers: {
        'orkestra-browser': {
          type: 'stdio',
          command: '/usr/bin/node',
          args: ['/bridge.js'],
          env: { ORKESTRA_TOOLS_TOKEN: 'secret-token', ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    });
  });

  it('returns nothing when no server is valid', () => {
    expect(buildClaudeSessionMcp([{ ...server, name: 'bad name' }], ctx)).toEqual({
      args: [],
      files: [],
    });
  });

  it('is registered on the Claude prompt behavior and composes before the prompt', () => {
    const build = provider.behavior.prompt?.buildSessionMcp;
    expect(build).toBe(buildClaudeSessionMcp);
    const command = provider.behavior.prompt!.buildCommand({
      cli: '/bin/claude',
      autoApprove: false,
      initialPrompt: 'do it',
      sessionId: 'conversation-1',
      model: '',
    });
    const args = [...build!([server], ctx).args, ...command.args];
    expect(args[0]).toBe('--mcp-config=/tmp/cfg dir/claude-mcp.json');
    expect(args.at(-1)).toBe('do it');
  });
});
