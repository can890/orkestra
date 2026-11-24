import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpRegistryClient,
  AcpRegistryUnavailableError,
  REGISTRY_FRESH_MS,
  REGISTRY_STALE_AFTER_MS,
  type FetchLike,
} from './registry-client';

const fixture = readFileSync(join(__dirname, 'fixtures/registry-index.fixture.json'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-acp-registry-'));
  dirs.push(dir);
  return dir;
}

function fakeFetch() {
  const state = { online: true, body: fixture, calls: [] as string[] };
  const fetch = vi.fn<FetchLike>(async (url) => {
    state.calls.push(url);
    if (!state.online) throw new TypeError('getaddrinfo ENOTFOUND cdn.agentclientprotocol.com');
    return new Response(state.body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { state, fetch };
}

describe('AcpRegistryClient', () => {
  it('reuses a fresh index, refetches after the fresh window and on explicit refresh', async () => {
    let now = 1_000_000;
    const { state, fetch } = fakeFetch();
    const client = new AcpRegistryClient({ cacheDir: tempDir(), fetch, now: () => now });

    const first = await client.load();
    expect(first).toMatchObject({ offline: false, stale: false, fetchedAt: 1_000_000 });
    expect(first.index.agents.length).toBeGreaterThan(5);
    expect(state.calls).toEqual([
      'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    ]);

    now += REGISTRY_FRESH_MS - 1;
    await client.load();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 2;
    await client.load();
    expect(fetch).toHaveBeenCalledTimes(2);

    await client.load({ refresh: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('falls back to the disk cache offline and reports it as stale', async () => {
    const cacheDir = tempDir();
    let now = 5_000;
    const online = fakeFetch();
    await new AcpRegistryClient({ cacheDir, fetch: online.fetch, now: () => now }).load();

    // Yeni süreç: ağ yok, bellek boş → diskteki önbellek.
    now += 60_000;
    const offline = fakeFetch();
    offline.state.online = false;
    const client = new AcpRegistryClient({ cacheDir, fetch: offline.fetch, now: () => now });
    const result = await client.load();
    expect(result.offline).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.fetchedAt).toBe(5_000);
    expect(result.offlineReason).toContain('ENOTFOUND');
    expect(result.index.agents.length).toBeGreaterThan(5);

    // Başarısızlıktan hemen sonra ağ yeniden denenmez; yenile her zaman dener.
    await client.load();
    expect(offline.fetch).toHaveBeenCalledTimes(1);
    offline.state.online = true;
    const refreshed = await client.load({ refresh: true });
    expect(refreshed).toMatchObject({ offline: false, stale: false, fetchedAt: now });
  });

  it('marks a successfully fetched index stale once it is older than a day', async () => {
    let now = 0;
    const { state, fetch } = fakeFetch();
    const client = new AcpRegistryClient({ cacheDir: tempDir(), fetch, now: () => now });
    await client.load();
    state.online = false;
    now += REGISTRY_STALE_AFTER_MS + 1;
    const result = await client.load();
    expect(result.stale).toBe(true);
    expect(result.offline).toBe(true);
  });

  it('fails without a cache when the network is down', async () => {
    const { state, fetch } = fakeFetch();
    state.online = false;
    const client = new AcpRegistryClient({ cacheDir: tempDir(), fetch });
    await expect(client.load()).rejects.toBeInstanceOf(AcpRegistryUnavailableError);
  });

  it('aborts a slow request with a short timeout', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new AcpRegistryClient({ cacheDir: tempDir(), fetch, timeoutMs: 20 });
    await expect(client.load()).rejects.toThrow(/Timed out/);
  });

  it('rejects oversized and invalid responses without replacing the cache', async () => {
    const cacheDir = tempDir();
    const good = fakeFetch();
    let now = 0;
    const client = new AcpRegistryClient({ cacheDir, fetch: good.fetch, now: () => now });
    await client.load();
    good.state.body = '{"not":"a registry"}';
    now += REGISTRY_FRESH_MS + 1;
    const result = await client.load();
    expect(result.offline).toBe(true);
    expect(result.index.agents.length).toBeGreaterThan(5);
    const cached = JSON.parse(readFileSync(join(cacheDir, 'registry-cache.json'), 'utf8'));
    expect(cached.fetchedAt).toBe(0);

    const huge = vi.fn<FetchLike>(
      async () =>
        new Response('x'.repeat(10), { headers: { 'content-length': `${2 * 1024 * 1024}` } })
    );
    const fresh = new AcpRegistryClient({ cacheDir: tempDir(), fetch: huge });
    await expect(fresh.load()).rejects.toThrow(/exceeds/);
  });

  it('downloads icons only from the official registry CDN', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const fetch = vi.fn<FetchLike>(
      async () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
    );
    const client = new AcpRegistryClient({ cacheDir: tempDir(), fetch });
    const base = { name: 'A', version: '1.0.0', description: '', distribution: {} };
    const official = await client.iconDataUri({
      ...base,
      id: 'a',
      icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/a.svg',
    });
    expect(official).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    expect(
      await client.iconDataUri({ ...base, id: 'b', icon: 'https://evil.example/b.svg' })
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
