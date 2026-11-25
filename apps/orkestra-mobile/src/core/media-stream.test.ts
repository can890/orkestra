import { base64UrlEncode, randomBytes } from '@orkestra/wire/remote';
import {
  createRemoteServer,
  listenRemoteServer,
  type RemoteListener,
  type RemoteServer,
} from '@orkestra/wire/remote/node';
import { WireError } from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDesktop, fakeMediaByte, type FakeDesktop } from '../testing/fake-desktop';
import { createConnectionManager, type ConnectionManager } from './connection-manager';
import {
  describeMediaError,
  isMissingFileMessage,
  LEGACY_HOST_MESSAGE,
  MediaStreamRegistry,
  streamBlockBytes,
  type NativeMediaApi,
} from './media-stream';
import { createRemoteApi, type RemoteApi } from './wire-client';

/** Yerel (Java) vekilin JS'e görünen yüzünü taklit eder; aralık sonuçlarını kaydeder. */
function fakeNative() {
  const opened: Record<string, unknown>[] = [];
  const results = new Map<string, { base64: string; error: string }>();
  const probes: string[] = [];
  const saves: string[] = [];
  const native: NativeMediaApi = {
    mediaProxyAvailable: () => true,
    mediaStreamOpen: (json) => {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      opened.push(parsed);
      const streamId = `s${opened.length}`;
      return JSON.stringify({ streamId, url: `http://127.0.0.1:5555/tok/${streamId}/x` });
    },
    mediaRangeResult: (reqId, base64, error) => {
      results.set(reqId, { base64, error });
    },
    mediaStreamProbe: (streamId, kind) => {
      probes.push(`${streamId}|${kind}`);
      return true;
    },
    mediaStreamSave: (streamId, mode) => {
      saves.push(`${streamId}|${mode}`);
      return `job-${saves.length}`;
    },
    mediaStreamCancelSave: vi.fn(),
  };
  return { native, opened, results, probes, saves };
}

function setup(api: RemoteApi) {
  const events = new EventTarget();
  const fake = fakeNative();
  const registry = new MediaStreamRegistry({ native: () => fake.native, events: () => events });
  const emit = (name: string, detail: unknown) =>
    events.dispatchEvent(new CustomEvent(name, { detail }));
  return { registry, events, emit, ...fake, api };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Zaman aşımı: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const NEW_HOST = {
  name: 'render.mp4',
  mimeType: 'video/mp4',
  size: 6 * 1024 ** 3,
  maxChunkBytes: 8 * 1024 * 1024,
};

describe('MediaStreamRegistry (yerel vekil köprüsü)', () => {
  it('yerel vekil yokken akış açmaz (tarayıcı yedeğine düşülür)', () => {
    const registry = new MediaStreamRegistry({ native: () => undefined, events: () => undefined });
    const api = { call: vi.fn(), live: vi.fn() } as unknown as RemoteApi;
    expect(registry.available()).toBe(false);
    expect(registry.open(api, 'c1', '/x.mp4', NEW_HOST)).toBeNull();
  });

  it('yeni sunucuda 2 MiB, eski sunucuda 1 MiB blok ister', () => {
    expect(streamBlockBytes({ maxChunkBytes: 8 * 1024 * 1024 })).toBe(2 * 1024 * 1024);
    expect(streamBlockBytes({ maxChunkBytes: 512 * 1024 })).toBe(512 * 1024);
    expect(streamBlockBytes({})).toBe(1024 * 1024);
    const api = { call: vi.fn(), live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    const opened = t.registry.open(api, 'c1', '/out/render.mp4', NEW_HOST);
    expect(opened).toEqual({ streamId: 's1', url: 'http://127.0.0.1:5555/tok/s1/x' });
    expect(t.opened[0]).toMatchObject({
      key: 'c1|/out/render.mp4',
      size: NEW_HOST.size,
      mimeType: 'video/mp4',
      blockBytes: 2 * 1024 * 1024,
    });
  });

  it('aralık isteğini readMediaPreview ile karşılar ve base64 döndürür', async () => {
    const call = vi.fn(async () => ({ base64: 'QUJD', size: NEW_HOST.size, eof: false }));
    const api = { call, live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    t.registry.open(api, 'c1', '/out/render.mp4', NEW_HOST);
    t.emit('sovra:media-range', {
      reqId: 'r1',
      streamId: 's1',
      offset: 5_000_000_000,
      length: 2_097_152,
    });
    await waitFor(() => t.results.has('r1'), 'aralık sonucu');
    expect(call).toHaveBeenCalledWith('conversations.readMediaPreview', {
      conversationId: 'c1',
      uri: '/out/render.mp4',
      offset: 5_000_000_000,
      maxBytes: 2_097_152,
    });
    expect(t.results.get('r1')).toEqual({ base64: 'QUJD', error: '' });
  });

  it('eski masaüstünün 80 MB hatasını açık mesaja çevirir ve dinleyiciye bildirir', async () => {
    const call = vi.fn(async () => {
      throw new WireError('HANDLER_ERROR', 'Dosya mobil aktarım boyut sınırını (80 MB) aşıyor.');
    });
    const api = { call, live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    t.registry.open(api, 'c1', '/big.mp4', { ...NEW_HOST, maxChunkBytes: undefined });
    const heard: string[] = [];
    t.registry.onError('s1', (m) => heard.push(m));
    t.emit('sovra:media-range', { reqId: 'r9', streamId: 's1', offset: 0, length: 1024 });
    await waitFor(() => t.results.has('r9'), 'hata sonucu');
    expect(t.results.get('r9')).toEqual({ base64: '', error: LEGACY_HOST_MESSAGE });
    expect(heard).toEqual([LEGACY_HOST_MESSAGE]);
    expect(t.registry.lastError('s1')).toBe(LEGACY_HOST_MESSAGE);
  });

  it('dosya değiştiyse ya da akış bilinmiyorsa hata döner (asılı kalmaz)', async () => {
    const call = vi.fn(async () => ({ base64: 'QUJD', size: 10 }));
    const api = { call, live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    t.registry.open(api, 'c1', '/a.mp4', {
      name: 'a.mp4',
      mimeType: 'video/mp4',
      size: 99,
      maxChunkBytes: 1 << 23,
    });
    t.emit('sovra:media-range', { reqId: 'r1', streamId: 's1', offset: 0, length: 10 });
    t.emit('sovra:media-range', { reqId: 'r2', streamId: 'yok', offset: 0, length: 10 });
    await waitFor(() => t.results.has('r1') && t.results.has('r2'), 'sonuçlar');
    expect(t.results.get('r1')?.error).toMatch(/değişmiş/);
    expect(t.results.get('r2')?.error).toMatch(/bulunamadı/);
  });

  it('önizleme sonucunu olaydan alır ve önbelleğe koyar', async () => {
    const api = { call: vi.fn(), live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    t.registry.open(api, 'c1', '/a.mp4', NEW_HOST);
    const pending = t.registry.probe('s1', 'video');
    t.emit('sovra:media-probe', {
      streamId: 's1',
      kind: 'video',
      ok: true,
      durationMs: 61_000,
      width: 1080,
      height: 1920,
      thumbnail: 'data:image/jpeg;base64,AA',
    });
    await expect(pending).resolves.toEqual({
      durationMs: 61_000,
      width: 1080,
      height: 1920,
      pageCount: undefined,
      thumbnail: 'data:image/jpeg;base64,AA',
    });
    await t.registry.probe('s1', 'video');
    expect(t.probes).toEqual(['s1|video']);
  });

  it('kaydetme ilerlemesini bildirir; hata mesajını iletir', async () => {
    const api = { call: vi.fn(), live: vi.fn() } as unknown as RemoteApi;
    const t = setup(api);
    t.registry.open(api, 'c1', '/a.mp4', NEW_HOST);
    const progress: number[] = [];
    const job = t.registry.save('s1', 'download', (p) => progress.push(p.written));
    expect(job?.jobId).toBe('job-1');
    t.emit('sovra:media-save', { jobId: 'job-1', state: 'progress', written: 10, total: 20 });
    t.emit('sovra:media-save', { jobId: 'other', state: 'done' });
    t.emit('sovra:media-save', { jobId: 'job-1', state: 'done', written: 20, total: 20 });
    await expect(job?.done).resolves.toBeUndefined();
    expect(progress).toEqual([10]);

    const failing = t.registry.save('s1', 'open');
    t.emit('sovra:media-save', {
      jobId: 'job-2',
      state: 'error',
      error: 'Bilgisayardan zamanında yanıt gelmedi.',
    });
    await expect(failing?.done).rejects.toThrow('Bilgisayardan zamanında yanıt gelmedi.');
    failing?.cancel();
    expect(t.native.mediaStreamCancelSave).toHaveBeenCalledWith('job-2');
  });

  it('hata mesajlarını kullanıcı diline çevirir', () => {
    expect(
      describeMediaError(new WireError('CONTRACT_MISMATCH', 'invalid input for remote access'), {
        offset: 50 * 1024 * 1024,
      })
    ).toBe(LEGACY_HOST_MESSAGE);
    expect(
      describeMediaError(new WireError('HANDLER_ERROR', "ENOENT: no such file, stat '/x'"))
    ).toBe('Dosya bilgisayarda bulunamadı.');
    expect(
      describeMediaError(new WireError('HANDLER_ERROR', 'Bu dosyaya uzak erişimle okuma izni yok.'))
    ).toBe('Bu dosyaya uzak erişimle okuma izni yok.');
  });

  it('uzak makinedeki eksik dosyayı makine adıyla gösterir ve indirmeyi kapatır', () => {
    const remote = describeMediaError(
      new WireError('HANDLER_ERROR', 'Dosya bulunamadı (build-box).')
    );
    expect(remote).toBe('Dosya bulunamadı (build-box).');
    expect(isMissingFileMessage(remote)).toBe(true);
    expect(
      isMissingFileMessage(
        describeMediaError(new WireError('HANDLER_ERROR', "ENOENT: no such file, stat '/x'"))
      )
    ).toBe(true);
    expect(
      isMissingFileMessage('build-box makinesindeki dosya okunamadı. Bağlantıyı kontrol et.')
    ).toBe(false);
    expect(isMissingFileMessage('Medya akışı bulunamadı.')).toBe(false);
    expect(isMissingFileMessage(null)).toBe(false);
  });
});

describe('medya akışı ↔ gerçek şifreli geçit (127.0.0.1)', () => {
  const DEVICE_ID = 'device-media-0001';
  const secret = randomBytes(32);
  let desktop: FakeDesktop;
  let server: RemoteServer;
  let listener: RemoteListener;
  let manager: ConnectionManager | undefined;

  afterEach(async () => {
    manager?.stop();
    manager = undefined;
    await listener?.close();
  });

  async function connect(): Promise<RemoteApi> {
    desktop = createFakeDesktop();
    server = createRemoteServer({
      controller: desktop.controller,
      lookupSecret: async (id) => (id === DEVICE_ID ? secret : null),
      hostInfo: () => ({
        hostId: 'h',
        hostName: 'Test Mac',
        addresses: ['127.0.0.1'],
        port: listener.port,
      }),
    });
    listener = await listenRemoteServer(server, { host: '127.0.0.1', port: 0 });
    manager = createConnectionManager({
      record: {
        hostId: 'h',
        hostName: 'Test Mac',
        addresses: ['127.0.0.1'],
        port: listener.port,
        deviceId: DEVICE_ID,
        secret: base64UrlEncode(secret),
        pairedAt: 1,
      },
      clientName: 'Medya Telefon',
      platform: 'android',
      backoffMs: [20, 40, 80],
      handshakeTimeoutMs: 2000,
      pingIntervalMs: 0,
      idleTimeoutMs: 0,
    });
    const m = manager;
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    return createRemoteApi(m.connection);
  }

  it('6 GB dosyanın 5 GB sonrasından 2 MiB blokları şifreli bağlantıdan bayt bayt doğru gelir', async () => {
    const api = await connect();
    const t = setup(api);
    const meta = (await api.call('conversations.readMediaPreview', {
      conversationId: 'c1',
      uri: '/out/render.mp4',
      offset: 0,
      maxBytes: 4096,
    })) as { name: string; mimeType: string; size: number; maxChunkBytes?: number };
    const opened = t.registry.open(api, 'c1', '/out/render.mp4', meta);
    expect(opened).not.toBeNull();
    const block = streamBlockBytes(meta);
    expect(block).toBe(2 * 1024 * 1024);
    const offsets = [5 * 1024 ** 3, 5 * 1024 ** 3 + block, meta.size - 1000];
    offsets.forEach((offset, i) =>
      t.emit('sovra:media-range', {
        reqId: `r${i}`,
        streamId: opened!.streamId,
        offset,
        length: Math.min(block, meta.size - offset),
      })
    );
    await waitFor(() => offsets.every((_, i) => t.results.has(`r${i}`)), 'bloklar', 15_000);
    offsets.forEach((offset, i) => {
      const result = t.results.get(`r${i}`)!;
      expect(result.error).toBe('');
      const bytes = Buffer.from(result.base64, 'base64');
      expect(bytes.length).toBe(Math.min(block, meta.size - offset));
      for (const probe of [0, 1, bytes.length >> 1, bytes.length - 1]) {
        expect(bytes[probe]).toBe(fakeMediaByte(offset + probe));
      }
    });
  });

  it('eski masaüstünde büyük dosya net mesajla reddedilir', async () => {
    const api = await connect();
    desktop.media.legacy = true;
    const t = setup(api);
    const opened = t.registry.open(api, 'c1', '/out/render.mp4', {
      name: 'render.mp4',
      mimeType: 'video/mp4',
      size: desktop.media.size,
    });
    t.emit('sovra:media-range', {
      reqId: 'old',
      streamId: opened!.streamId,
      offset: 0,
      length: 1024 * 1024,
    });
    await waitFor(() => t.results.has('old'), 'eski sunucu yanıtı');
    expect(t.results.get('old')).toEqual({ base64: '', error: LEGACY_HOST_MESSAGE });
  });
});
