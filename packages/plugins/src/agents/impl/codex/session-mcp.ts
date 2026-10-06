import type {
  SessionMcpContext,
  SessionMcpLaunch,
  SessionMcpServer,
} from '@orkestra/core/services/agent-plugins/api/plugins';
import {
  posixEnvFileContents,
  selectSessionMcpServers,
  tomlInlineStringTable,
  tomlString,
  tomlStringArray,
  wrapWithPosixEnvFile,
} from '@orkestra/core/services/agent-plugins/api/plugins/helpers';

/**
 * Codex CLI'ye oturuma özel MCP sunucularını `-c mcp_servers.<ad>={...}` geçersiz kılmalarıyla
 * verir; `~/.codex/config.toml` değişmez ve kullanıcının diğer sunucuları korunur. Değer TOML
 * satır içi tablosu olarak ayrıştırılır.
 *
 * Ortam değişkenleri (belirteçler) POSIX makinelerde 0600 izinli bir dosyaya yazılır ve sunucu
 * bu dosyayı yükleyen `/bin/sh` sarmalayıcısıyla başlar; böylece belirteç ne Codex'in
 * argümanlarında ne de Codex'in (ajan kabuklarına geçen) ortamında görünür. Windows'ta kabuk
 * sarmalayıcısı olmadığından değerler satır içi `env` tablosuna yazılır.
 */
export function buildCodexSessionMcp(
  servers: SessionMcpServer[],
  ctx: SessionMcpContext
): SessionMcpLaunch {
  const args: string[] = [];
  const files: SessionMcpLaunch['files'] = [];
  for (const server of selectSessionMcpServers(servers)) {
    const env = server.env ?? {};
    let launch = { command: server.command, args: server.args };
    let inlineEnv: Record<string, string> | null = null;
    if (Object.keys(env).length > 0) {
      if (ctx.platform === 'win32') {
        inlineEnv = env;
      } else {
        const envFile = `${server.name}.env`;
        files.push({ name: envFile, contents: posixEnvFileContents(env) });
        launch = wrapWithPosixEnvFile(server, ctx.filePath(envFile));
      }
    }
    const fields = [
      `command=${tomlString(launch.command)}`,
      `args=${tomlStringArray(launch.args)}`,
    ];
    if (inlineEnv) fields.push(`env=${tomlInlineStringTable(inlineEnv)}`);
    args.push('-c', `mcp_servers.${server.name}={${fields.join(',')}}`);
  }
  return { args, files };
}
