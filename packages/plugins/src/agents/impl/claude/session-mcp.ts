import type {
  SessionMcpContext,
  SessionMcpLaunch,
  SessionMcpServer,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import { selectSessionMcpServers } from '@orkestra/core/services/agent-plugins/api/plugins/helpers';

const CONFIG_FILE_NAME = 'claude-mcp.json';

/**
 * Claude Code'a oturuma özel MCP sunucularını `--mcp-config` ile verir. Bayrak eklemelidir
 * (`--strict-mcp-config` verilmedikçe kullanıcının sunucuları da yüklenir). Ortam değişkenleri
 * (belirteçler) argümanlarda değil, 0600 izinli yapılandırma dosyasında durur.
 *
 * `=` biçimi bilinçlidir: bayrak değişken sayıda değer alır ve ayrı yazıldığında kendisinden sonra
 * gelen konumsal ilk istemi de yapılandırma sanabilir.
 */
export function buildClaudeSessionMcp(
  servers: SessionMcpServer[],
  ctx: SessionMcpContext
): SessionMcpLaunch {
  const selected = selectSessionMcpServers(servers);
  if (selected.length === 0) return { args: [], files: [] };
  const mcpServers = Object.fromEntries(
    selected.map((server) => [
      server.name,
      { type: 'stdio', command: server.command, args: server.args, env: server.env ?? {} },
    ])
  );
  return {
    args: [`--mcp-config=${ctx.filePath(CONFIG_FILE_NAME)}`],
    files: [{ name: CONFIG_FILE_NAME, contents: `${JSON.stringify({ mcpServers }, null, 2)}\n` }],
  };
}
