import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateEvent } from '@core/features/updates/api';
import { UpdateRefusedError } from './code-signature';
import type { InAppInstaller, PreparedUpdate } from './mac-installer';
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
      assets: [
        {
          name: 'orkestra-arm64.zip',
          browser_download_url: `${RELEASES}/download/${tag}/orkestra-arm64.zip`,
          size: 1024,
        },
        {
          name: 'SHA256SUMS',
          browser_download_url: `${RELEASES}/download/${tag}/SHA256SUMS`,
          size: 170,
        },
      ],
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const services: UpdateService[] = [];

type FakeInstaller = {
  [K in keyof InAppInstaller]: ReturnType<typeof vi.fn<InAppInstaller[K]>>;
};

/** Varsayılan olarak uygulama içi kurulumu desteklemeyen sahte kurucu (eski davranış). */
function fakeInstaller(overrides: Partial<FakeInstaller> = {}): FakeInstaller {
  return {
    checkSupport: vi.fn<InAppInstaller['checkSupport']>(async () => ({
      supported: false,
      reason: 'desteklenmiyor',
    })),
    prepare: vi.fn<InAppInstaller['prepare']>(async () => {
      throw new Error('prepare should not run');
    }),
    isPrepared: vi.fn<InAppInstaller['isPrepared']>(async () => true),
    launchInstaller: vi.fn<InAppInstaller['launchInstaller']>(async () => {}),
    takeInstallFailure: vi.fn<InAppInstaller['takeInstallFailure']>(async () => null),
    cleanup: vi.fn<InAppInstaller['cleanup']>(async () => {}),
    ...overrides,
  };
}

function inAppInstaller(overrides: Partial<FakeInstaller> = {}): FakeInstaller {
  return fakeInstaller({
    checkSupport: vi.fn<InAppInstaller['checkSupport']>(async () => ({
      supported: true,
      bundlePath: '/Applications/Orkestra.app',
    })),
    prepare: vi.fn<InAppInstaller['prepare']>(async (release, onProgress) => {
      onProgress({ bytesPerSecond: 10, percent: 50, transferred: 512, total: 1024 });
      return { version: release.version, appPath: '/tmp/x/Orkestra.app', workDir: '/tmp/x' };
    }),
    ...overrides,
  });
}

async function createService(
  responses: Array<Response | Error>,
  version = '1.2.17',
  options: { installer?: FakeInstaller; autoDownload?: boolean } = {}
) {
  const events: DesktopUpdateEvent[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const openExternal = vi.fn(async (_url: string) => {});
  const installer = options.installer ?? fakeInstaller();
  const quit = vi.fn();
  const deps: UpdateServiceDeps = {
    fetch,
    openExternal,
    resolveVersion: async () => version,
    emit: (event) => events.push(event),
    getAutoDownload: async () => options.autoDownload ?? true,
    installer,
    quit,
  };
  const service = new UpdateService(deps);
  services.push(service);
  const publisher = { available: vi.fn(), downloaded: vi.fn(), error: vi.fn() };
  service.setNotificationPublisher(publisher);
  await service.initialize();
  return { service, fetch, openExternal, events, publisher, installer, quit };
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
    expect(events).toEqual([
      { type: 'checking' },
      {
        type: 'available',
        version: '1.2.18',
        installMode: 'manual',
        manualReason: 'desteklenmiyor',
        autoDownload: false,
      },
    ]);
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

  it('opens the found release page and never a foreign URL when installs are manual', async () => {
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

  it('refuses to install when nothing was downloaded', async () => {
    const { service, quit } = await createService([]);

    await expect(service.quitAndInstall()).rejects.toThrow('Kurulmaya hazır bir güncelleme yok');
    expect(service.isActive).toBe(false);
    expect(service.isInstallRequested).toBe(false);
    expect(quit).not.toHaveBeenCalled();
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('UpdateService in-app install', () => {
  it('downloads automatically, reports progress and becomes ready to restart', async () => {
    const installer = inAppInstaller();
    const { service, events, publisher } = await createService([release('v1.2.18')], '1.2.17', {
      installer,
    });

    await service.checkForUpdates();
    await flush();

    expect(installer.prepare).toHaveBeenCalledTimes(1);
    expect(installer.prepare.mock.calls[0]![0]).toMatchObject({
      version: '1.2.18',
      assets: [
        { name: 'orkestra-arm64.zip', size: 1024 },
        { name: 'SHA256SUMS', size: 170 },
      ],
    });
    expect(events.map((event) => event.type)).toEqual([
      'checking',
      'available',
      'downloading',
      'progress',
      'downloaded',
    ]);
    expect(events[1]).toMatchObject({ installMode: 'in-app', autoDownload: true });
    expect(service.getState()).toMatchObject({
      status: 'downloaded',
      availableVersion: '1.2.18',
      installMode: 'in-app',
    });
    expect(service.isActive).toBe(true);
    expect(publisher.downloaded).toHaveBeenCalledWith('1.2.18');
  });

  it('waits for the user when automatic download is off', async () => {
    const installer = inAppInstaller();
    const { service, events } = await createService([release('v1.2.18')], '1.2.17', {
      installer,
      autoDownload: false,
    });

    await service.checkForUpdates();
    await flush();
    expect(installer.prepare).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'available', autoDownload: false });

    await service.downloadUpdate();
    expect(service.getState().status).toBe('downloaded');
  });

  it('keeps the version and offers a retry after a failed download', async () => {
    let attempt = 0;
    const installer = inAppInstaller({
      prepare: vi.fn<InAppInstaller['prepare']>(async (releaseInfo) => {
        attempt += 1;
        if (attempt === 1) throw new Error('Güncelleme indirilirken bağlantı koptu (offline).');
        return { version: releaseInfo.version, appPath: '/tmp/y/Orkestra.app', workDir: '/tmp/y' };
      }),
    });
    const { service, events } = await createService([release('v1.2.18')], '1.2.17', {
      installer,
      autoDownload: false,
    });
    await service.checkForUpdates();

    await expect(service.downloadUpdate()).rejects.toThrow('bağlantı koptu');
    expect(service.getState()).toMatchObject({
      status: 'error',
      availableVersion: '1.2.18',
      installMode: 'in-app',
    });
    expect(events.at(-1)).toMatchObject({ type: 'error' });

    await service.downloadUpdate();
    expect(service.getState().status).toBe('downloaded');
  });

  it('falls back to the release page when a package is refused', async () => {
    const installer = inAppInstaller({
      prepare: vi.fn<InAppInstaller['prepare']>(async () => {
        throw new UpdateRefusedError('İmza kimliği eşleşmiyor.');
      }),
    });
    const { service, openExternal } = await createService([release('v1.2.18')], '1.2.17', {
      installer,
      autoDownload: false,
    });
    await service.checkForUpdates();

    await expect(service.downloadUpdate()).rejects.toThrow('İmza kimliği eşleşmiyor.');
    expect(service.getState()).toMatchObject({
      status: 'error',
      installMode: 'manual',
      manualReason: 'İmza kimliği eşleşmiyor.',
    });
    expect(service.isActive).toBe(false);

    await service.downloadUpdate();
    expect(installer.prepare).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenLastCalledWith(`${RELEASES}/tag/v1.2.18`);
  });

  it('starts the helper and quits on install; stays ready if spawning fails', async () => {
    const installer = inAppInstaller();
    const { service, quit, events } = await createService([release('v1.2.18')], '1.2.17', {
      installer,
    });
    await service.checkForUpdates();
    await flush();

    installer.launchInstaller.mockRejectedValueOnce(new Error('spawn EACCES'));
    await expect(service.quitAndInstall()).rejects.toThrow('Kurulum yardımcısı başlatılamadı');
    expect(service.getState().status).toBe('downloaded');
    expect(service.isInstallRequested).toBe(false);
    expect(quit).not.toHaveBeenCalled();

    await service.quitAndInstall();
    expect(installer.launchInstaller).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '1.2.18', appPath: '/tmp/x/Orkestra.app' })
    );
    expect(service.getState().status).toBe('installing');
    expect(events.at(-1)).toEqual({ type: 'installing' });
    expect(service.isInstallRequested).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('asks for a new download when the prepared files disappeared', async () => {
    const installer = inAppInstaller();
    const { service, quit } = await createService([release('v1.2.18')], '1.2.17', { installer });
    await service.checkForUpdates();
    await flush();

    installer.isPrepared.mockResolvedValueOnce(false);
    await expect(service.quitAndInstall()).rejects.toThrow('yeniden indirin');
    expect(service.getState().status).toBe('available');
    expect(quit).not.toHaveBeenCalled();
  });

  it('keeps a downloaded update ready across later checks, even failing ones', async () => {
    const installer = inAppInstaller();
    const { service } = await createService(
      [release('v1.2.18'), release('v1.2.18'), new TypeError('offline')],
      '1.2.17',
      { installer }
    );
    await service.checkForUpdates();
    await flush();

    await service.checkForUpdates();
    expect(service.getState().status).toBe('downloaded');
    await expect(service.checkForUpdates()).resolves.toMatchObject({ version: '1.2.18' });
    expect(service.getState().status).toBe('downloaded');
    expect(installer.prepare).toHaveBeenCalledTimes(1);
  });

  it('does not start a second check or download while downloading', async () => {
    let finish: (value: PreparedUpdate) => void = () => {};
    const installer = inAppInstaller({
      prepare: vi.fn<InAppInstaller['prepare']>(
        () =>
          new Promise<PreparedUpdate>((resolve) => {
            finish = resolve;
          })
      ),
    });
    const { service, fetch } = await createService([release('v1.2.18')], '1.2.17', { installer });
    await service.checkForUpdates();
    await flush();
    expect(service.getState().status).toBe('downloading');

    await service.checkForUpdates();
    const second = service.downloadUpdate();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(installer.prepare).toHaveBeenCalledTimes(1);

    finish({ version: '1.2.18', appPath: '/tmp/z/Orkestra.app', workDir: '/tmp/z' });
    await second;
    expect(service.getState().status).toBe('downloaded');
  });

  it('reports a failed previous install once a publisher is attached', async () => {
    const installer = fakeInstaller({
      takeInstallFailure: vi.fn<InAppInstaller['takeInstallFailure']>(
        async () => 'Yeni sürüm yerine konamadı; eski sürüm geri yüklendi.'
      ),
    });
    const deps: UpdateServiceDeps = {
      fetch: vi.fn(),
      openExternal: vi.fn(async () => {}),
      resolveVersion: async () => '1.2.17',
      emit: () => {},
      getAutoDownload: async () => true,
      installer,
      quit: vi.fn(),
    };
    const service = new UpdateService(deps);
    services.push(service);
    await service.initialize();

    expect(service.getState()).toMatchObject({
      status: 'error',
      error: 'Son güncelleme kurulamadı: Yeni sürüm yerine konamadı; eski sürüm geri yüklendi.',
    });
    expect(installer.cleanup).toHaveBeenCalledWith('1.2.17');
    const publisher = { available: vi.fn(), downloaded: vi.fn(), error: vi.fn() };
    service.setNotificationPublisher(publisher);
    expect(publisher.error).toHaveBeenCalledTimes(1);
  });
});
