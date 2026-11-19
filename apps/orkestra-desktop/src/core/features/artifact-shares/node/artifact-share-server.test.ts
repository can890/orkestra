import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactShareServer } from './artifact-share-server';

const html = new TextEncoder().encode('<h1>merhaba</h1>');
const css = new TextEncoder().encode('body{}');

function makeServer(options: ConstructorParameters<typeof ArtifactShareServer>[0] = {}) {
  return new ArtifactShareServer({
    bindHost: '127.0.0.1',
    listAddresses: () => ['127.0.0.1'],
    ...options,
  });
}

function tokenOf(url: string): string {
  return new URL(url).pathname.split('/')[2]!;
}

function http(
  port: number,
  path: string,
  method = 'GET'
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const servers: ArtifactShareServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

async function shareOne(server: ArtifactShareServer) {
  servers.push(server);
  const result = await server.create({
    name: 'rapor',
    entry: 'index.html',
    files: [
      { path: 'index.html', bytes: html },
      { path: 'img/site.css', bytes: css },
    ],
  });
  if (!result.success) throw new Error(result.error.message);
  return { info: result.data, port: server.listeningPort!, token: tokenOf(result.data.urls[0]!) };
}

describe('ArtifactShareServer', () => {
  it('hiç paylaşım yokken port dinlemez', () => {
    const server = makeServer();
    expect(server.listening).toBe(false);
    expect(server.listeningPort).toBeNull();
  });

  it('doğru belirteçle içeriği ve güvenlik başlıklarını döner', async () => {
    const { port, token } = await shareOne(makeServer());
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const res = await http(port, `/a/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('<h1>merhaba</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const sub = await http(port, `/a/${token}/img/site.css`);
    expect(sub.status).toBe(200);
    expect(sub.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('HEAD gövdesiz 200 döner', async () => {
    const { port, token } = await shareOne(makeServer());
    const res = await http(port, `/a/${token}`, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });

  it('yanlış, eksik ve başka biçimli belirteçlerde gövdesiz 404 döner', async () => {
    const { port, token } = await shareOne(makeServer());
    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const path of [
      '/',
      '/a',
      '/a/',
      `/a/${wrong}`,
      '/a/kisa',
      `/a/${token}x`,
      '/b/' + token,
    ]) {
      const res = await http(port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe('');
    }
  });

  it('path traversal denemeleri 404 döner', async () => {
    const { port, token } = await shareOne(makeServer());
    const attempts = [
      `/a/${token}/../../etc/passwd`,
      `/a/${token}/%2e%2e/%2e%2e/etc/passwd`,
      `/a/${token}/..%2f..%2fetc%2fpasswd`,
      `/a/${token}/%2fetc/passwd`,
      `/a/${token}/img/../index.html`,
      `/a/${token}/img%5c..%5cindex.html`,
      `/a/${token}/%00`,
      `/a/${token}/img/`,
      `/a/${token}/img`,
      `/a/${token}/%zz`,
    ];
    for (const path of attempts) {
      const res = await http(port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe('');
    }
  });

  it('GET/HEAD dışındaki yöntemleri reddeder', async () => {
    const { port, token } = await shareOne(makeServer());
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await http(port, `/a/${token}`, method);
      expect(res.status, method).toBe(405);
      expect(res.body).toBe('');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('iptal sonrası 404 döner ve son paylaşım bitince port kapanır', async () => {
    const server = makeServer();
    const first = await shareOne(server);
    const second = await server.create({
      name: 'ikinci',
      entry: 'a.html',
      files: [{ path: 'a.html', bytes: html }],
    });
    if (!second.success) throw new Error('create');
    expect(server.list()).toHaveLength(2);
    const secondToken = tokenOf(second.data.urls[0]!);

    await server.revoke(first.info.id);
    expect((await http(first.port, `/a/${first.token}`)).status).toBe(404);
    expect((await http(first.port, `/a/${secondToken}`)).status).toBe(200);
    expect(server.listening).toBe(true);

    await server.revoke(second.data.id);
    expect(server.listening).toBe(false);
    expect(await canConnect(first.port)).toBe(false);
  });

  it('dispose tüm paylaşımları bitirir ve portu kapatır', async () => {
    const server = makeServer();
    const { port } = await shareOne(server);
    await server.dispose();
    expect(server.list()).toEqual([]);
    expect(await canConnect(port)).toBe(false);
  });

  it('boyut sınırını, geçersiz adları ve eksik ana dosyayı reddeder; port açılmaz', async () => {
    const server = makeServer({ maxBytes: 10 });
    servers.push(server);
    const big = await server.create({
      name: 'x',
      entry: 'a.html',
      files: [{ path: 'a.html', bytes: new Uint8Array(11) }],
    });
    expect(big.success).toBe(false);
    for (const path of ['../a.html', '/a.html', 'a\\b.html', 'a//b.html', '']) {
      const bad = await server.create({ name: 'x', entry: path, files: [{ path, bytes: html }] });
      expect(bad.success, path).toBe(false);
    }
    const noEntry = await server.create({
      name: 'x',
      entry: 'yok.html',
      files: [{ path: 'a.html', bytes: new Uint8Array(1) }],
    });
    expect(noEntry.success).toBe(false);
    expect(server.listening).toBe(false);
  });

  it('etkin paylaşım sayısını sınırlar', async () => {
    const server = makeServer({ maxActive: 1 });
    await shareOne(server);
    const second = await server.create({
      name: 'x',
      entry: 'a.html',
      files: [{ path: 'a.html', bytes: html }],
    });
    expect(second.success).toBe(false);
  });

  it('ağ adresi yoksa paylaşım oluşturmaz ve port açmaz', async () => {
    const server = makeServer({ listAddresses: () => [] });
    servers.push(server);
    const result = await server.create({
      name: 'x',
      entry: 'a.html',
      files: [{ path: 'a.html', bytes: html }],
    });
    expect(result.success).toBe(false);
    expect(server.listening).toBe(false);
  });
});
