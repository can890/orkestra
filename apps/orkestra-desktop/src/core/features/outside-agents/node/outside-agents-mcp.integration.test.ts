import { request as httpRequest } from 'node:http';
import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { OutsideAgentsService } from './outside-agents-service';
import { FakeBackend, MemoryPersistence, MemorySecretStore } from './testing/fakes';

// Uçtan uca: gerçek HTTP sunucusu geçici bir portta açılır, sahte proje/sohbet arka ucuyla
// initialize -> tools/list -> okuma aracı -> salt okunur belirteçle eylem (red) -> eylem belirteciyle
// eylem (başarılı) -> iptal akışı çalıştırılır.

type HttpResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return send(url, 'POST', JSON.stringify(body), headers);
}

function send(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string>
): Promise<HttpResult> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

let service: OutsideAgentsService | null = null;

afterEach(async () => {
  await service?.dispose();
  service = null;
});

async function boot() {
  const backend = new FakeBackend();
  const secrets = new MemorySecretStore();
  service = new OutsideAgentsService({
    persistence: new MemoryPersistence(),
    secrets,
    logger: noopLogger,
    isSecureStorageAvailable: () => true,
    serverVersion: '0.0.0-test',
    createBackend: () => backend,
    serverOverrides: { port: 0, sleep: async () => {} },
  });
  await service.start({});
  const configured = await service.configure({ enabled: true });
  if (!configured.success) throw new Error('configure failed');
  const url = configured.data.url!;
  return { backend, secrets, url, service };
}

async function client(service: OutsideAgentsService, name: string, access: 'read' | 'act') {
  const created = await service.createClient(name, access);
  if (!created.success) throw new Error('create failed');
  return created.data;
}

function rpc(
  url: string,
  token: string,
  id: number,
  method: string,
  params?: unknown,
  session?: string
) {
  return post(
    url,
    { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) },
    {
      authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    }
  );
}

describe('outside agents MCP server (integration)', () => {
  it('is not listening until the user turns it on', async () => {
    service = new OutsideAgentsService({
      persistence: new MemoryPersistence(),
      secrets: new MemorySecretStore(),
      logger: noopLogger,
      isSecureStorageAvailable: () => true,
      serverVersion: '0.0.0-test',
      createBackend: () => new FakeBackend(),
      serverOverrides: { port: 0 },
    });
    await service.start({});
    const status = await service.getStatus();
    expect(status).toMatchObject({ enabled: false, listening: false, url: null });
  });

  it('runs initialize, tools/list, read, refused act, allowed act and revoke', async () => {
    const { backend, url, service: svc } = await boot();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const reader = await client(svc, 'AtlasBar', 'read');
    const actor = await client(svc, 'Claude Code', 'act');
    expect(reader.setup.claudeCode).toContain(url);

    // initialize
    const init = await rpc(url, reader.token, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.serverInfo.name).toBe('orkestra');
    expect(init.body.result.capabilities.tools).toBeDefined();
    const session = init.headers['mcp-session-id'] as string;
    expect(session).toBeTruthy();

    // initialized bildirimi: 202, gövde yok
    const notified = await post(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: `Bearer ${reader.token}`, 'mcp-session-id': session }
    );
    expect(notified.status).toBe(202);

    // tools/list
    const list = await rpc(url, reader.token, 2, 'tools/list', {}, session);
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual([
      'orkestra_capabilities',
      'orkestra_project_list',
      'orkestra_conversation_list',
      'orkestra_conversation_read',
      'orkestra_conversation_status',
      'orkestra_conversation_wait',
      'orkestra_conversation_start',
      'orkestra_conversation_send',
    ]);
    const startTool = list.body.result.tools.find(
      (tool: { name: string }) => tool.name === 'orkestra_conversation_start'
    );
    expect(startTool.inputSchema.type).toBe('object');
    expect(startTool.inputSchema.required).toEqual(['projectId', 'provider', 'message']);
    expect(startTool.annotations.readOnlyHint).toBe(false);

    // okuma aracı
    const projects = await rpc(
      url,
      reader.token,
      3,
      'tools/call',
      { name: 'orkestra_project_list', arguments: { limit: 1 } },
      session
    );
    expect(projects.body.result.isError).toBe(false);
    expect(projects.body.result.structuredContent).toEqual({
      projects: [
        {
          projectId: 'project-1',
          name: 'Alpha',
          path: '/tmp/alpha',
          location: 'local',
          hasRepository: true,
        },
      ],
      nextCursor: 1,
      total: 2,
    });

    const read = await rpc(
      url,
      reader.token,
      4,
      'tools/call',
      { name: 'orkestra_conversation_read', arguments: { conversationId: 'conv-1', limit: 2 } },
      session
    );
    const transcript = read.body.result.structuredContent;
    expect(transcript.source).toBe('saved');
    expect(transcript.turns.map((turn: { turn: number }) => turn.turn)).toEqual([14, 15]);
    expect(transcript.nextBefore).toBe('saved:14');
    expect(transcript.conversation.status.state).toBe('finished');

    // salt okunur belirteçle eylem: reddedilir, arka uca hiçbir şey ulaşmaz
    const refused = await rpc(
      url,
      reader.token,
      5,
      'tools/call',
      {
        name: 'orkestra_conversation_start',
        arguments: { projectId: 'project-1', provider: 'claude', message: 'Find slow tests' },
      },
      session
    );
    expect(refused.status).toBe(200);
    expect(refused.body.result.isError).toBe(true);
    expect(refused.body.result.content[0].text).toContain('read-only');
    expect(backend.started).toHaveLength(0);
    const refusedSend = await rpc(url, reader.token, 6, 'tools/call', {
      name: 'orkestra_conversation_send',
      arguments: { conversationId: 'conv-1', message: 'hi' },
    });
    expect(refusedSend.body.result.isError).toBe(true);
    expect(backend.sent).toHaveLength(0);

    // eylem belirteciyle: başarılı
    const actorInit = await rpc(url, actor.token, 7, 'initialize', {
      protocolVersion: '2025-03-26',
    });
    const actorSession = actorInit.headers['mcp-session-id'] as string;
    expect(actorInit.body.result.protocolVersion).toBe('2025-03-26');
    const started = await rpc(
      url,
      actor.token,
      8,
      'tools/call',
      {
        name: 'orkestra_conversation_start',
        arguments: {
          projectId: 'project-1',
          provider: 'claude',
          model: 'opus',
          message: 'Find why the tests are slow\nand fix them',
        },
      },
      actorSession
    );
    expect(started.body.result.isError).toBe(false);
    expect(started.body.result.structuredContent).toMatchObject({
      conversationId: 'conv-new-1',
      projectId: 'project-1',
      title: 'Find why the tests are slow',
      provider: 'claude',
      started: true,
    });
    expect(backend.started[0]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      message: 'Find why the tests are slow\nand fix them',
    });
    const sent = await rpc(
      url,
      actor.token,
      9,
      'tools/call',
      {
        name: 'orkestra_conversation_send',
        arguments: { conversationId: 'conv-1', message: 'Now fix it' },
      },
      actorSession
    );
    expect(sent.body.result.structuredContent).toEqual({ conversationId: 'conv-1', queued: false });
    expect(backend.sent).toEqual([
      { conversationId: 'conv-1', text: 'Now fix it', placement: 'auto' },
    ]);

    // oturum başka istemciye ait olamaz
    const crossed = await rpc(url, actor.token, 10, 'tools/list', {}, session);
    expect(crossed.status).toBe(404);

    // iptal: belirteç ve açık oturum hemen geçersiz
    const revoked = await svc.revokeClient(actor.client.id);
    expect(revoked.success).toBe(true);
    const afterRevoke = await rpc(url, actor.token, 11, 'tools/list', {}, actorSession);
    expect(afterRevoke.status).toBe(401);
    // diğer istemci etkilenmez
    const stillOk = await rpc(url, reader.token, 12, 'ping', {}, session);
    expect(stillOk.body.result).toEqual({});

    const status = await svc.getStatus();
    expect(status.clients.map((entry) => entry.name)).toEqual(['AtlasBar']);
    expect(status.clients[0]?.lastUsedAt).not.toBeNull();
  });

  it('applies a permission downgrade to the next call', async () => {
    const { url, service: svc, backend } = await boot();
    const actor = await client(svc, 'Hermes', 'act');
    await svc.setClientAccess(actor.client.id, 'read');
    const refused = await rpc(url, actor.token, 1, 'tools/call', {
      name: 'orkestra_conversation_send',
      arguments: { conversationId: 'conv-1', message: 'hello' },
    });
    expect(refused.body.result.isError).toBe(true);
    expect(backend.sent).toHaveLength(0);
  });

  it('refuses missing tokens, browser origins, foreign Host headers and bad input', async () => {
    const { url, service: svc } = await boot();
    const reader = await client(svc, 'Reader', 'read');
    const noToken = await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(noToken.status).toBe(401);
    expect(noToken.headers['www-authenticate']).toContain('Bearer');

    const browser = await post(
      url,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${reader.token}`, origin: 'https://evil.example' }
    );
    expect(browser.status).toBe(403);

    const rebinding = await post(
      url,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { authorization: `Bearer ${reader.token}`, host: 'evil.example:80' }
    );
    expect(rebinding.status).toBe(403);

    const get = await send(url, 'GET', null, { authorization: `Bearer ${reader.token}` });
    expect(get.status).toBe(405);

    const batch = await post(url, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], {
      authorization: `Bearer ${reader.token}`,
    });
    expect(batch.status).toBe(400);

    const badArgs = await rpc(url, reader.token, 2, 'tools/call', {
      name: 'orkestra_conversation_read',
      arguments: { conversationId: 'conv-1', limit: 5000 },
    });
    expect(badArgs.body.result.isError).toBe(true);
    expect(badArgs.body.result.content[0].text).toContain('Invalid arguments');

    const unknown = await rpc(url, reader.token, 3, 'resources/list', {});
    expect(unknown.body.error.code).toBe(-32601);
  });

  it('stops listening when turned off', async () => {
    const { url, service: svc } = await boot();
    const reader = await client(svc, 'Reader', 'read');
    await svc.configure({ enabled: false });
    await expect(rpc(url, reader.token, 1, 'ping')).rejects.toThrow();
    expect((await svc.getStatus()).listening).toBe(false);
  });
});
