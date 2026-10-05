import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Köprünün bağlantı bilgisini okuduğu ortam değişkeni adları. */
export type AgentToolsBridgeEnvNames = Readonly<{
  /** Yerel RPC uç noktası (http://127.0.0.1:<port>/rpc). */
  url: string;
  /** Uzak makinede SSH ters tüneline bağlanan Unix soketi. */
  socket: string;
  token: string;
  /** Köprünün bağlandığı araç sunucusunun kimliği; sunucu belirteçle eşleştiğini doğrular. */
  server?: string;
}>;

/** Orkestra araç sunucularının (ör. tarayıcı) genel ortam değişkenleri. */
export const AGENT_TOOLS_BRIDGE_ENV = {
  url: 'ORKESTRA_TOOLS_URL',
  socket: 'ORKESTRA_TOOLS_SOCKET',
  token: 'ORKESTRA_TOOLS_TOKEN',
  server: 'ORKESTRA_TOOLS_SERVER',
} as const satisfies AgentToolsBridgeEnvNames;

/**
 * Şef (Orkestra modu) köprüsünün ilk sürümden beri kullandığı adlar. Köprü, genel belirteç
 * yoksa bunlara düşer; böylece şef araçlarının ortamı değişmeden kalır.
 */
export const ORCHESTRA_BRIDGE_ENV = {
  url: 'ORKESTRA_ORCHESTRA_URL',
  socket: 'ORKESTRA_ORCHESTRA_SOCKET',
  token: 'ORKESTRA_ORCHESTRA_TOKEN',
} as const satisfies AgentToolsBridgeEnvNames;

/** Köprünün hangi araç sunucusuna bağlandığını bildirdiği HTTP başlığı. */
export const AGENT_TOOLS_SERVER_HEADER = 'x-orkestra-tools-server';

/**
 * Ajanların başlattığı bağımlılıksız MCP stdio köprüsü. Satır sınırlı JSON-RPC alır; araç
 * tanımlarını ve çağrılarını Orkestra'nın RPC sunucusuna iletir. Araç mantığı ana süreçte
 * kalır, böylece betik kararlıdır ve tek bir betik birden çok araç sunucusuna hizmet eder.
 * Araç sonuçlarının içerik blokları (metin, görüntü) olduğu gibi aktarılır. Yerelde Electron
 * ikilisiyle (`ELECTRON_RUN_AS_NODE=1`), uzakta workspace-server'ın Node'uyla çalışır.
 */
export const AGENT_TOOLS_BRIDGE_SOURCE = String.raw`'use strict';
const http = require('node:http');
const env = process.env;
// Genel belirteç varsa genel değişkenler, yoksa şef köprüsünün ilk adları okunur.
const generic = Boolean(env.${AGENT_TOOLS_BRIDGE_ENV.token});
const ENDPOINT = generic ? env.${AGENT_TOOLS_BRIDGE_ENV.url} : env.${ORCHESTRA_BRIDGE_ENV.url};
// Uzak makinelerde köprü, SSH ters tüneliyle masaüstüne bağlanan bir Unix soketi kullanır.
const SOCKET = generic ? env.${AGENT_TOOLS_BRIDGE_ENV.socket} : env.${ORCHESTRA_BRIDGE_ENV.socket};
const TOKEN = generic ? env.${AGENT_TOOLS_BRIDGE_ENV.token} : env.${ORCHESTRA_BRIDGE_ENV.token};
const SERVER = generic ? env.${AGENT_TOOLS_BRIDGE_ENV.server} || '' : '';
const TIMEOUT_MS = 15 * 60 * 1000;
// Bağlantı kurulamadıysa (SSH yeniden bağlanırken soket henüz yok) istek sunucuya hiç ulaşmamıştır;
// kısa aralıklarla yeniden denemek güvenlidir.
const CONNECT_RETRIES = 3;
const CONNECT_RETRY_MS = 1000;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function rpc(method, params, attempt) {
  const tries = attempt || 0;
  return request(method, params).catch((error) => {
    const code = error && error.code;
    if (tries >= CONNECT_RETRIES || (code !== 'ECONNREFUSED' && code !== 'ENOENT')) throw error;
    return new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS)).then(() =>
      rpc(method, params, tries + 1)
    );
  });
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    if ((!ENDPOINT && !SOCKET) || !TOKEN) {
      reject(new Error('Orkestra connection settings are missing.'));
      return;
    }
    const body = JSON.stringify({ method, params: params || {} });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: 'Bearer ' + TOKEN,
    };
    if (SERVER) headers['${AGENT_TOOLS_SERVER_HEADER}'] = SERVER;
    let target;
    if (SOCKET) {
      target = { socketPath: SOCKET, path: '/rpc' };
    } else {
      const url = new URL(ENDPOINT);
      target = { hostname: url.hostname, port: url.port, path: url.pathname };
    }
    const outgoing = http.request(
      { ...target, method: 'POST', headers, timeout: TIMEOUT_MS },
      (response) => {
        // Büyük yanıtlar (ekran görüntüleri) parça parça gelir; tek seferde çözülür.
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            reject(new Error('Could not read the Orkestra response: ' + String(error)));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error((parsed && parsed.error) || 'HTTP ' + response.statusCode));
          } else {
            resolve(parsed);
          }
        });
      }
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('The Orkestra request timed out.')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

// Araç sunucusu içerik blokları döndürürse olduğu gibi, düz metin döndürürse tek blok olarak.
function toolContent(result) {
  if (result && Array.isArray(result.content)) return result.content;
  return [{ type: 'text', text: result.text }];
}

async function handle(message) {
  if (message.id === undefined || message.id === null) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  try {
    switch (message.method) {
      case 'initialize': {
        const info = await rpc('describe');
        reply({
          protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: typeof info.name === 'string' && info.name ? info.name : 'orkestra',
            version: '1.0.0',
          },
          instructions: info.instructions,
        });
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list': {
        const info = await rpc('describe');
        reply({ tools: info.tools });
        return;
      }
      case 'tools/call': {
        const params = message.params || {};
        try {
          const result = await rpc('call', { name: params.name, arguments: params.arguments || {} });
          reply({ content: toolContent(result), isError: Boolean(result.isError) });
        } catch (error) {
          reply({ content: [{ type: 'text', text: errorText(error) }], isError: true });
        }
        return;
      }
      default:
        fail(-32601, 'Method not found: ' + message.method);
    }
  } catch (error) {
    fail(-32603, errorText(error));
  }
}

let buffer = '';
let pending = 0;
let ended = false;

// Bekleyen yanıtlar tamamlanmadan ve stdout'a yazılan veri boşaltılmadan çıkılmaz; aksi halde
// büyük yanıtlar borunun tamponunda kesilir.
function exitWhenIdle() {
  if (!ended || pending > 0) return;
  process.stdout.write('', () => process.exit(0));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    pending += 1;
    void handle(message).finally(() => {
      pending -= 1;
      exitWhenIdle();
    });
  }
});
process.stdin.on('end', () => {
  ended = true;
  exitWhenIdle();
});
`;

/** Köprü dosya adı; içerik özetini taşır, böylece farklı sürümler çakışmaz. */
export function agentToolsBridgeFileName(): string {
  const digest = createHash('sha256').update(AGENT_TOOLS_BRIDGE_SOURCE).digest('hex').slice(0, 12);
  return `orkestra-mcp-bridge-${digest}.cjs`;
}

/**
 * Betiği içerik özetini taşıyan bir dosya adıyla yazar; aynı içerik tekrar yazılmaz. Yazım
 * geçici dosya + yeniden adlandırma ile yapılır: eşzamanlı başlayan köprüler yarım dosya görmez.
 */
export async function ensureAgentToolsBridgeScript(directory: string): Promise<string> {
  const path = join(directory, agentToolsBridgeFileName());
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing !== AGENT_TOOLS_BRIDGE_SOURCE) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, AGENT_TOOLS_BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }
  return path;
}
