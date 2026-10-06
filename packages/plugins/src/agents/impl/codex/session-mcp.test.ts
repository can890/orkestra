import { describe, expect, it } from 'vitest';
import { provider } from './index';
import { buildCodexSessionMcp } from './session-mcp';

const filePath = (name: string) => `/tmp/cfg/${name}`;
const server = {
  name: 'orkestra-browser',
  command: '/opt/my node/node',
  args: ['/x/bridge "q".js'],
  env: { ORKESTRA_TOOLS_TOKEN: "s'ecret", ELECTRON_RUN_AS_NODE: '1' },
};

describe('buildCodexSessionMcp', () => {
  it('overrides one mcp_servers table per server and loads env from a 0600 file on POSIX', () => {
    const launch = buildCodexSessionMcp([server], { platform: 'linux', filePath });
    expect(launch.args).toEqual([
      '-c',
      'mcp_servers.orkestra-browser={command="/bin/sh",args=["-c",". \\"$1\\" && shift && exec \\"$@\\"","orkestra-mcp-env","/tmp/cfg/orkestra-browser.env","/opt/my node/node","/x/bridge \\"q\\".js"]}',
    ]);
    expect(launch.args.join(' ')).not.toContain('ecret');
    expect(launch.files).toEqual([
      {
        name: 'orkestra-browser.env',
        contents: "export ORKESTRA_TOOLS_TOKEN='s'\\''ecret'\nexport ELECTRON_RUN_AS_NODE=1\n",
      },
    ]);
  });

  it('uses an inline env table on Windows where no shell wrapper exists', () => {
    const launch = buildCodexSessionMcp([server], { platform: 'win32', filePath });
    expect(launch.files).toEqual([]);
    expect(launch.args).toEqual([
      '-c',
      'mcp_servers.orkestra-browser={command="/opt/my node/node",args=["/x/bridge \\"q\\".js"],env={"ORKESTRA_TOOLS_TOKEN"="s\'ecret","ELECTRON_RUN_AS_NODE"="1"}}',
    ]);
  });

  it('launches env-less servers directly and skips names Codex cannot address', () => {
    const launch = buildCodexSessionMcp(
      [
        { name: 'plain', command: '/bin/tool', args: [] },
        { name: 'dotted.name', command: '/bin/tool', args: [] },
      ],
      { platform: 'darwin', filePath }
    );
    expect(launch).toEqual({
      args: ['-c', 'mcp_servers.plain={command="/bin/tool",args=[]}'],
      files: [],
    });
  });

  it('is registered on the Codex prompt behavior; overrides precede the resume subcommand', () => {
    const build = provider.behavior.prompt?.buildSessionMcp;
    expect(build).toBe(buildCodexSessionMcp);
    const command = provider.behavior.prompt!.buildCommand({
      cli: '/bin/codex',
      autoApprove: false,
      isResuming: true,
      providerSessionId: 'thread-1',
      sessionId: 'conversation-1',
      model: '',
    });
    const args = [...build!([server], { platform: 'linux', filePath }).args, ...command.args];
    expect(args.slice(0, 1)).toEqual(['-c']);
    expect(args.slice(2, 4)).toEqual(['resume', 'thread-1']);
  });
});
