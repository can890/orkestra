import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateEvent } from '@core/features/updates/api';
import { UpdateService, type UpdateServiceDeps } from './update-service';

const RELEASES = 'https://github.com/can890/orkestra/releases';

function release(tag: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      name: `Orkestra ${tag}`,
      html_url: `${RELEASES}/tag/${tag}`,
      published_at: '2026-10-05T12:48:10Z',
      body: 'Sürüm notları',
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const services: UpdateService[] = [];

async function createService(responses: Array<Response | Error>, version = '1.2.17') {
  const events: DesktopUpdateEvent[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const openExternal = vi.fn(async (_url: string) => {});
  const deps: UpdateServiceDeps = {
    fetch,
    openExternal,
    resolveVersion: async () => version,
    emit: (event) => events.push(event),
  };
  const service = new UpdateService(deps);
  services.push(service);
  const publisher = { available: vi.fn(), downloaded: vi.fn(), error: vi.fn() };
  service.setNotificationPublisher(publisher);
  await service.initialize();
  return { service, fetch, openExternal, events, publisher };
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe('UpdateService', () => {
  it('reports a newer GitHub release and notifies once per version', async () => {
    const { service, fetch, events, publisher } = await createService([
      release('v1.2.18'),
      release('v1.2.18'),
    ]);

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      version: '1.2.18',
      releaseUrl: `${RELEASES}/tag/v1.2.18`,
    });
    expect(service.getState()).toMatchObject({ status: 'available', availableVersion: '1.2.18' });
    expect(events).toEqual([{ type: 'checking' }, { type: 'available', version: '1.2.18' }]);
    await expect(service.fetchReleaseNotes()).resolves.toBe('Sürüm notları');

    await service.checkForUpdates();
    expect(publisher.available).toHaveBeenCalledTimes(1);
    expect(publisher.available).toHaveBeenCalledWith('1.2.18');

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/can890/orkestra/releases/latest');
    expect(init.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Orkestra/1.2.17',
    });
  });

  it('reports the running or an older release as current', async () => {
    const { service, events, publisher } = await createService([
      release('v1.2.17'),
      release('v1.2.16'),
    ]);

    await expect(service.checkForUpdates()).resolves.toBeNull();
    expect(service.getState().status).toBe('not-available');
    await expect(service.checkForUpdates()).resolves.toBeNull();
    expect(events.at(-1)).toEqual({ type: 'not-available' });
    expect(publisher.available).not.toHaveBeenCalled();
  });

  it('explains rate limits, network failures and timeouts in Turkish', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
      code: 23,
    });
    const { service, events } = await createService([
      new Response('{}', { status: 403 }),
      new TypeError('fetch failed'),
      timeout,
    ]);

    await expect(service.checkForUpdates()).rejects.toThrow('GitHub istek sınırına ulaşıldı');
    expect(service.getState()).toMatchObject({ status: 'error' });
    expect(events.at(-1)).toMatchObject({ type: 'error' });

    await expect(service.checkForUpdates()).rejects.toThrow("GitHub'a ulaşılamadı: fetch failed");

    await expect(service.checkForUpdates()).rejects.toThrow("GitHub'a ulaşılamadı");
    expect(service.getState().error).not.toContain('HTTP 23');
  });

  it('keeps a newer version found earlier when a later check fails', async () => {
    const { service } = await createService([release('v1.2.18'), new TypeError('offline')]);

    await service.checkForUpdates();
    await expect(service.checkForUpdates()).rejects.toThrow('offline');
    expect(service.getState()).toMatchObject({ status: 'error', availableVersion: '1.2.18' });
  });

  it('shares one request between concurrent checks', async () => {
    const { service, fetch } = await createService([release('v1.2.18')]);

    const [first, second] = await Promise.all([
      service.checkForUpdates(),
      service.checkForUpdates(),
    ]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens the found release page, never a foreign URL, and never downloads in-app', async () => {
    const found = await createService([release('v1.2.18')]);
    await found.service.openReleasePage();
    expect(found.openExternal).toHaveBeenLastCalledWith(`${RELEASES}/latest`);
    await found.service.checkForUpdates();
    await found.service.downloadUpdate();
    expect(found.openExternal).toHaveBeenLastCalledWith(`${RELEASES}/tag/v1.2.18`);

    const foreign = await createService([
      release('v1.2.18', { html_url: 'https://example.com/orkestra.dmg' }),
    ]);
    await foreign.service.checkForUpdates();
    await foreign.service.openReleasePage();
    expect(foreign.openExternal).toHaveBeenLastCalledWith(`${RELEASES}/latest`);
  });

  it('rejects a release tag that is not a version', async () => {
    const { service } = await createService([release('nightly')]);

    await expect(service.checkForUpdates()).rejects.toThrow('Son sürümün etiketi okunamadı');
  });

  it('refuses in-app installs with manual instructions', async () => {
    const { service } = await createService([]);

    expect(() => service.quitAndInstall()).toThrow('elle kurulur');
    expect(service.isActive).toBe(false);
  });
});
