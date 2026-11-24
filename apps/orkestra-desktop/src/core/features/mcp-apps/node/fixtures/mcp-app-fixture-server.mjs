#!/usr/bin/env node
// Test fikstürü: MCP Apps destekleyen küçük bir MCP sunucusu. Varsayılan olarak stdio üzerinden
// konuşur; `--http` ile 127.0.0.1 üzerinde rastgele bir portta Streamable HTTP (JSON yanıt) açar
// ve portu stdout'a `PORT <n>` olarak yazar. Hiçbir dış ağ ya da dosya erişimi yoktur.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const RESOURCE_URI = 'ui://fixture/dashboard';
const APP_HTML =
  '<!doctype html><html><head><title>Fixture</title></head><body><div id="app">fixture app</div>' +
  '<script>window.fixture = true;</script></body></html>';

let counter = 0;
let advertisedUi = false;

const tools = [
  {
    name: 'show_dashboard',
    description: 'Shows the dashboard app.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  },
  {
    name: 'get_data',
    description: 'Read-only data for the app.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, title: 'Get data' },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'set_value',
    description: 'Changes the counter.',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
    annotations: { title: 'Set value' },
  },
  {
    name: 'model_only',
    description: 'Hidden from apps.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'plain_tool',
    description: 'A tool without an app.',
    inputSchema: { type: 'object' },
  },
];

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  switch (method) {
    case 'initialize':
      advertisedUi = Boolean(params?.capabilities?.extensions?.['io.modelcontextprotocol/ui']);
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mcp-app-fixture', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = params?.name;
      if (name === 'show_dashboard') {
        return reply({
          ...text('Dashboard shown'),
          structuredContent: { city: params?.arguments?.city ?? null },
        });
      }
      if (name === 'get_data') {
        return reply({
          ...text(`counter=${counter}`),
          structuredContent: { counter, advertisedUi },
        });
      }
      if (name === 'set_value') {
        counter = Number(params?.arguments?.value ?? counter + 1);
        return reply(text(`counter set to ${counter}`));
      }
      if (name === 'model_only' || name === 'plain_tool') return reply(text('ok'));
      return fail(-32602, `Unknown tool: ${name}`);
    }
    case 'resources/read': {
      if (params?.uri !== RESOURCE_URI) return fail(-32002, 'Resource not found');
      return reply({
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: APP_HTML,
            _meta: {
              ui: {
                csp: {
                  connectDomains: ['https://api.fixture.test', "'self'"],
                  resourceDomains: ['https://cdn.fixture.test'],
                },
                permissions: { clipboardWrite: {} },
                prefersBorder: true,
              },
            },
          },
        ],
      });
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

if (process.argv.includes('--http')) {
  const sessionId = 'fixture-session';
  const server = createServer((request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== sessionId) {
        response.writeHead(400).end();
        return;
      }
      const answer = handle(message);
      if (!answer) {
        response.writeHead(202).end();
        return;
      }
      // initialize yanıtı SSE, diğerleri JSON: istemcinin iki biçimi de okuduğu sınanır.
      if (message.method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-session-id': sessionId,
        });
        response.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`PORT ${server.address().port}\n`);
  });
  process.stdin.on('end', () => server.close(() => process.exit(0)));
  process.stdin.resume();
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const answer = handle(message);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
  lines.on('close', () => process.exit(0));
}
