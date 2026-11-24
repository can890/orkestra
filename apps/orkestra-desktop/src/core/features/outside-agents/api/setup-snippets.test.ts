import { describe, expect, it } from 'vitest';
import { buildOutsideAgentSetup, outsideAgentsMcpUrl } from './setup-snippets';

const TOKEN = `orkmcp_0123456789abcdef_${'a'.repeat(43)}`;

describe('buildOutsideAgentSetup', () => {
  it('builds Claude Code and Codex snippets for the loopback URL', () => {
    const url = outsideAgentsMcpUrl(47660);
    expect(url).toBe('http://127.0.0.1:47660/mcp');
    const setup = buildOutsideAgentSetup(url, TOKEN);
    expect(setup.claudeCode).toBe(
      `claude mcp add --transport http --scope user orkestra http://127.0.0.1:47660/mcp --header "Authorization: Bearer ${TOKEN}"`
    );
    expect(setup.codexToml).toBe(
      [
        '[mcp_servers.orkestra]',
        'url = "http://127.0.0.1:47660/mcp"',
        'bearer_token_env_var = "ORKESTRA_MCP_TOKEN"',
      ].join('\n')
    );
    // Belirteç config.toml'a değil, ortam değişkenine konur.
    expect(setup.codexToml).not.toContain(TOKEN);
    expect(setup.codexEnv).toBe(`export ORKESTRA_MCP_TOKEN='${TOKEN}'`);
  });

  it('refuses values that could break out of the shell or TOML snippet', () => {
    expect(() => buildOutsideAgentSetup('http://127.0.0.1:1/mcp', 'a"; rm -rf ~')).toThrow();
    expect(() => buildOutsideAgentSetup('http://evil.example/mcp', TOKEN)).toThrow();
  });
});
