import { OUTSIDE_AGENTS_MCP_PATH, type OutsideAgentSetup } from './contract';

// Dış ajan istemcileri için kopyalanmaya hazır kurulum parçaları. Orkestra bunları yalnızca
// kullanıcıya gösterir; kullanıcının Claude Code / Codex yapılandırmasına asla kendisi yazmaz.

/** İstemci yapılandırmasındaki MCP sunucu adı. */
export const OUTSIDE_AGENTS_SERVER_NAME = 'orkestra';

/** Codex'in belirteci okuduğu ortam değişkeni (belirteç config.toml'a yazılmasın diye). */
export const OUTSIDE_AGENTS_TOKEN_ENV = 'ORKESTRA_MCP_TOKEN';

/** Belirteçler yalnızca base64url ve `_` içerir; kabuk/TOML kaçışı gerektirmez. Yine de denetle. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;
const SAFE_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/[A-Za-z0-9/_-]*$/;

export function buildOutsideAgentSetup(url: string, token: string): OutsideAgentSetup {
  if (!SAFE_TOKEN.test(token)) throw new Error('Unexpected token format');
  if (!SAFE_URL.test(url)) throw new Error('Unexpected MCP URL');
  return {
    claudeCode: `claude mcp add --transport http --scope user ${OUTSIDE_AGENTS_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`,
    codexToml: [
      `[mcp_servers.${OUTSIDE_AGENTS_SERVER_NAME}]`,
      `url = "${url}"`,
      `bearer_token_env_var = "${OUTSIDE_AGENTS_TOKEN_ENV}"`,
    ].join('\n'),
    codexEnv: `export ${OUTSIDE_AGENTS_TOKEN_ENV}='${token}'`,
  };
}

export function outsideAgentsMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}${OUTSIDE_AGENTS_MCP_PATH}`;
}
