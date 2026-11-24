import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  createMediaToolHandler,
  httpsDownloader,
  nodeCliRunner,
  type MediaProviderSpec,
} from './cli-media-tools';

type JsonRpcRequest = { id?: number | string; method?: string; params?: Record<string, unknown> };

/** Finder'dan açılan uygulamada PATH kısa olabilir; kullanıcı araç dizinleri eklenir. */
function cliEnv(): NodeJS.ProcessEnv {
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const path = [...new Set([...extra, ...(process.env.PATH ?? '').split(delimiter)])]
    .filter(Boolean)
    .join(delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Bağımlılıksız, satır sınırlı JSON-RPC MCP stdio sunucusu. Ortam:
 * - `ORKESTRA_MEDIA_CLI`: CLI'ın mutlak yolu (yoksa ad PATH'te aranır)
 * - `ORKESTRA_MEDIA_OUTPUT_DIR`: üretilen dosyaların yazılacağı dizin (yoksa `<cwd>/orkestra-media`)
 * - `ORKESTRA_MEDIA_REQUIRE_CONFIRMATION`: `0` değilse harcama çağrıları onay ister
 */
export function startMediaStdioServer(spec: MediaProviderSpec, cliName: string): void {
  const outputDir = process.env.ORKESTRA_MEDIA_OUTPUT_DIR || join(process.cwd(), 'orkestra-media');
  const handler = createMediaToolHandler(spec, {
    run: nodeCliRunner,
    executable: process.env.ORKESTRA_MEDIA_CLI || cliName,
    outputDir,
    requireConfirmation: process.env.ORKESTRA_MEDIA_REQUIRE_CONFIRMATION !== '0',
    download: httpsDownloader,
    env: cliEnv(),
  });
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    const { id, method, params } = request;
    if (id === undefined || id === null) return;
    void (async () => {
      try {
        if (method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion:
                typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: spec.serverName, version: '1.0.0' },
              instructions: spec.instructions,
            },
          });
          return;
        }
        if (method === 'ping') {
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        }
        if (method === 'tools/list') {
          send({ jsonrpc: '2.0', id, result: { tools: handler.listTools() } });
          return;
        }
        if (method === 'tools/call') {
          const result = await handler.callTool(String(params?.name ?? ''), params?.arguments);
          send({ jsonrpc: '2.0', id, result });
          return;
        }
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported method: ${method}` },
        });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              { type: 'text', text: error instanceof Error ? error.message : String(error) },
            ],
          },
        });
      }
    })();
  });
  input.on('close', () => process.exit(0));
}
