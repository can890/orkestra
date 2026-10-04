import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const root =
  process.env.ORKESTRA_ELEVENLABS_DIRECTORY || join(homedir(), '.local/share/orkestra/elevenlabs');
const endpoint = new URL('https://api.us.elevenlabs.io/v1/mcp');
const lockPath = join(root, 'connection.lock');
const audioTools = new Set([
  'creative_generate_speech',
  'creative_list_voices',
  'creative_get_flow_run_status',
  'creative_show_flow_results',
  'creative_get_flow',
  'creative_get_flow_node',
  'creative_get_model_schema',
  'creative_get_model_guide',
]);
export async function forwardAudioTool(client, params, options) {
  if (!audioTools.has(params.name)) {
    throw new Error(
      'ElevenLabs bağlantısı yalnızca ses üretimi için ayarlı. Videoyu kodlama araçlarıyla hazırlayın.'
    );
  }
  return client.callTool(params, undefined, options);
}

function credential(action, value) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      join(root, 'python/bin/python'),
      [join(root, 'credentials.py'), action],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error)
          return reject(
            new Error('ElevenLabs hesabına erişilemedi. Hesap bağlantısını kontrol edin.')
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('ElevenLabs oturum kaydı okunamadı.'));
        }
      }
    );
    child.stdin.end(value ? JSON.stringify(value) : '');
  });
}
export async function withConnectionLock(operation, directory = lockPath) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'owner'), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(join(directory, 'owner'), 'utf8'));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (failure) {
            if (failure.code === 'ESRCH') {
              await rm(directory, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch {}
      if (Date.now() - started > 180000)
        throw new Error('ElevenLabs diğer isteği tamamlıyor. Biraz sonra tekrar deneyin.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const authProvider = {
  redirectUrl: undefined,
  clientMetadataUrl: 'https://chatgpt.com/oauth/codex/client.json',
  clientMetadata: {
    client_name: 'Orkestra ElevenLabs',
    redirect_uris: [],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  async clientInformation() {
    const data = await credential('read');
    return { client_id: data.client_id };
  },
  async tokens() {
    return (await credential('read')).token_response;
  },
  async saveTokens(tokens) {
    await credential('save', tokens);
  },
  async redirectToAuthorization() {
    throw new Error('ElevenLabs oturumunun yenilenmesi gerekiyor. Hesabı yeniden bağlayın.');
  },
  async saveCodeVerifier() {},
  async codeVerifier() {
    throw new Error('ElevenLabs hesabını resmi giriş ekranından bağlayın.');
  },
};
const remote = new Client({ name: 'Orkestra ElevenLabs', version: '1.0.0' });
let connected = false;
async function invoke(operation) {
  return withConnectionLock(async () => {
    if (!connected) {
      await remote.connect(new StreamableHTTPClientTransport(endpoint, { authProvider }));
      connected = true;
    }
    return operation(remote);
  });
}
export async function start() {
  const server = new Server(
    { name: 'Orkestra ElevenLabs', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    invoke(async (client) => {
      const result = await client.listTools(request.params);
      return { ...result, tools: result.tools.filter((tool) => audioTools.has(tool.name)) };
    })
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    invoke((client) =>
      forwardAudioTool(client, request.params, { signal: extra.signal, timeout: 180000 })
    )
  );
  server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    invoke((client) => client.listResources(request.params))
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
    invoke((client) => client.listResourceTemplates(request.params))
  );
  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    invoke((client) => client.readResource(request.params))
  );
  server.setRequestHandler(ListPromptsRequestSchema, (request) =>
    invoke((client) => client.listPrompts(request.params))
  );
  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    invoke((client) => client.getPrompt(request.params))
  );
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => remote.close().catch(() => {}));
}
if (process.env.ORKESTRA_ELEVENLABS_TEST !== '1')
  start().catch(() => {
    console.error('ElevenLabs bağlantısı başlatılamadı.');
    process.exitCode = 1;
  });
