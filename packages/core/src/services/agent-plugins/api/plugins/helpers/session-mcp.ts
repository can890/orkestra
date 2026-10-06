import { quoteArg } from '#primitives/exec/api';
import type { SessionMcpServer } from '#services/agent-plugins/api/plugins/capabilities/prompt';

/**
 * Oturuma özel MCP sunucularını sağlayıcı CLI'lerine aktaran yapı taşları. Sağlayıcıya özgü
 * biçimler (Claude JSON dosyası, Codex `-c` geçersiz kılmaları) eklentilerde kalır; burada yalnızca
 * ortak doğrulama ve kaçış kuralları bulunur.
 */

// Codex noktalı yolu `.` ile böler; adlar nokta ve boşluk içermemeli.
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** POSIX kabukta ortam dosyasını yükleyip asıl komutu çalıştıran sarmalayıcı betik. */
export const POSIX_ENV_FILE_WRAPPER_SCRIPT = '. "$1" && shift && exec "$@"';
const POSIX_ENV_FILE_WRAPPER_NAME = 'orkestra-mcp-env';

const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Argümana, TOML'a ya da kabuk dosyasına güvenle yazılamayan metinleri (NUL, yarım vekil) eler. */
function isSafeText(value: string): boolean {
  return !value.includes('\0') && !LONE_SURROGATE_PATTERN.test(value);
}

function isValidServer(server: SessionMcpServer): boolean {
  if (!SERVER_NAME_PATTERN.test(server.name)) return false;
  if (!server.command || !isSafeText(server.command)) return false;
  if (!server.args.every(isSafeText)) return false;
  return Object.entries(server.env ?? {}).every(
    ([name, value]) => ENV_NAME_PATTERN.test(name) && isSafeText(value)
  );
}

/**
 * Geçersiz adlı/değerli sunucuları atar ve aynı adlı sunuculardan ilkini tutar. Sağlayıcı CLI'si
 * bozuk bir girdi yüzünden hiç açılmamaktansa o sunucu olmadan açılmalıdır.
 */
export function selectSessionMcpServers(servers: readonly SessionMcpServer[]): SessionMcpServer[] {
  const seen = new Set<string>();
  return servers.filter((server) => {
    if (!isValidServer(server) || seen.has(server.name)) return false;
    seen.add(server.name);
    return true;
  });
}

/**
 * TOML temel dizgisi. JSON kaçışı TOML için yeterli değildir (DEL ve tek başına vekil karakterler),
 * bu yüzden kontrol karakterleri `\uXXXX` ile açıkça kaçırılır.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    // Dizgi yinelemesi eşleşmiş vekilleri tek kod noktası verir; bu aralık tek başına vekildir.
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error('TOML strings must be well-formed Unicode');
    }
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

/** Anahtarları da tırnaklanmış tek satırlık TOML satır içi tablosu. */
export function tomlInlineStringTable(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)}=${tomlString(value)}`
  );
  return `{${entries.join(',')}}`;
}

/** `. dosya` ile yüklenecek POSIX ortam dosyası; değerler tek tırnakla kaçırılır. */
export function posixEnvFileContents(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `export ${name}=${quoteArg(value, 'posix')}\n`)
    .join('');
}

/**
 * Sunucuyu, ortamını 0600 izinli bir dosyadan yükleyen `/bin/sh` sarmalayıcısıyla başlatır.
 * Böylece belirteçler ne sağlayıcının argümanlarında ne de sağlayıcının kendi ortamında görünür.
 */
export function wrapWithPosixEnvFile(
  server: Pick<SessionMcpServer, 'command' | 'args'>,
  envFilePath: string
): { command: string; args: string[] } {
  return {
    command: '/bin/sh',
    args: [
      '-c',
      POSIX_ENV_FILE_WRAPPER_SCRIPT,
      POSIX_ENV_FILE_WRAPPER_NAME,
      envFilePath,
      server.command,
      ...server.args,
    ],
  };
}
