import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Şef ajanın başlattığı bağımlılıksız MCP stdio köprüsü. Satır sınırlı JSON-RPC alır ve araç
 * tanımlarını/çağrılarını yerel Orkestra RPC sunucusuna iletir. Araç mantığı ana süreçte kalır;
 * böylece betik kararlıdır ve uygulama sürümünden bağımsızdır.
 */
const BRIDGE_SOURCE = String.raw`'use strict';
const http = require('node:http');
const ENDPOINT = process.env.ORKESTRA_ORCHESTRA_URL;
const TOKEN = process.env.ORKESTRA_ORCHESTRA_TOKEN;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ENDPOINT || !TOKEN) {
      reject(new Error('Orkestra bağlantı bilgisi eksik.'));
      return;
    }
    const body = JSON.stringify({ method, params: params || {} });
    const request = http.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer ' + TOKEN,
        },
        timeout: 15 * 60 * 1000,
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (response.statusCode !== 200) reject(new Error(parsed.error || 'HTTP ' + response.statusCode));
            else resolve(parsed);
          } catch (error) {
            reject(new Error('Orkestra yanıtı okunamadı: ' + String(error)));
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('Orkestra isteği zaman aşımına uğradı.')));
    request.on('error', reject);
    request.end(body);
  });
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
          serverInfo: { name: 'orkestra', version: '1.0.0' },
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
          reply({ content: [{ type: 'text', text: result.text }], isError: Boolean(result.isError) });
        } catch (error) {
          reply({ content: [{ type: 'text', text: String(error && error.message ? error.message : error) }], isError: true });
        }
        return;
      }
      default:
        fail(-32601, 'Method not found: ' + message.method);
    }
  } catch (error) {
    fail(-32603, String(error && error.message ? error.message : error));
  }
}

let buffer = '';
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
    void handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Betiği içerik özetini taşıyan bir dosya adıyla yazar; aynı sürüm tekrar yazılmaz. */
export async function ensureOrchestraBridgeScript(directory: string): Promise<string> {
  const digest = createHash('sha256').update(BRIDGE_SOURCE).digest('hex').slice(0, 12);
  const path = join(directory, `orkestra-mcp-bridge-${digest}.cjs`);
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing !== BRIDGE_SOURCE) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, BRIDGE_SOURCE, { encoding: 'utf8', mode: 0o600 });
  }
  return path;
}
