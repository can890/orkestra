import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_HOST_REF } from '@orkestra/core/primitives/host/api';
import { hostFileRef, parseAbsolute, type HostFileRef } from '@orkestra/core/primitives/path/api';
import { ok } from '@orkestra/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_STREAM_SCHEME } from '../../api/media-stream';
import { MediaStreamService } from './media-stream-service';

const MB = 1024 * 1024;
const BIG = 600 * MB;
const TAIL = Buffer.from('<<render-tail>>');

let dir: string;
let bigFile: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'orkestra-media-stream-')));
  bigFile = join(dir, 'render.mp4');
  // Seyrek dosya: 600 MB görünür boyut, diskte yalnızca kuyruk.
  await writeFile(bigFile, '');
  await truncate(bigFile, BIG);
  const handle = await open(bigFile, 'r+');
  await handle.write(Buffer.from('HEAD'), 0, 4, 0);
  await handle.write(TAIL, 0, TAIL.length, BIG - TAIL.length);
  await handle.close();
  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
});

function localRef(path: string): HostFileRef {
  const parsed = parseAbsolute(path);
  if (!parsed.success) throw new Error(`bad path ${path}`);
  return hostFileRef(LOCAL_HOST_REF, parsed.data);
}

function request(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

async function bodyText(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString('latin1');
}

describe('MediaStreamService (local)', () => {
  it('serves ranges of a 600 MB sparse file without buffering it', async () => {
    const service = new MediaStreamService({ remoteFs: () => Promise.reject(new Error('no')) });
    const opened = await service.open(localRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);
    expect(opened.data).toMatchObject({ size: BIG, mimeType: 'video/mp4', name: 'render.mp4' });
    expect(opened.data.url).toBe(`${MEDIA_STREAM_SCHEME}://media/${opened.data.token}`);

    const heapBefore = process.memoryUsage().heapUsed;
    const tail = await service.handle(
      request(opened.data.url, { Range: `bytes=${BIG - TAIL.length}-` })
    );
    expect(tail.status).toBe(206);
    expect(tail.headers.get('accept-ranges')).toBe('bytes');
    expect(tail.headers.get('content-range')).toBe(`bytes ${BIG - TAIL.length}-${BIG - 1}/${BIG}`);
    expect(tail.headers.get('content-length')).toBe(String(TAIL.length));
    expect(tail.headers.get('content-type')).toBe('video/mp4');
    expect(await bodyText(tail)).toBe(TAIL.toString('latin1'));

    const suffix = await service.handle(request(opened.data.url, { Range: 'bytes=-5' }));
    expect(suffix.status).toBe(206);
    expect(await bodyText(suffix)).toBe(TAIL.subarray(-5).toString('latin1'));

    const head = await service.handle(request(opened.data.url, { Range: 'bytes=0-3' }));
    expect(head.status).toBe(206);
    expect(await bodyText(head)).toBe('HEAD');

    // Aralıksız istek: 200 + tam uzunluk; gövde parça parça çekilir, tamamı okunmaz.
    const full = await service.handle(request(opened.data.url));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe(String(BIG));
    const reader = full.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThanOrEqual(256 * 1024);
    await reader.cancel();
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * MB);

    const outside = await service.handle(request(opened.data.url, { Range: `bytes=${BIG}-` }));
    expect(outside.status).toBe(416);
    expect(outside.headers.get('content-range')).toBe(`bytes */${BIG}`);
    const inverted = await service.handle(request(opened.data.url, { Range: 'bytes=9-3' }));
    expect(inverted.status).toBe(416);
  });

  it('streams the full 600 MB file through the handler in bounded memory', async () => {
    const service = new MediaStreamService({ remoteFs: () => Promise.reject(new Error('no')) });
    const opened = await service.open(localRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);
    const response = await service.handle(request(opened.data.url, { Range: 'bytes=0-' }));
    expect(response.status).toBe(206);
    const reader = response.body!.getReader();
    let received = 0;
    let peak = 0;
    const base = process.memoryUsage().rss;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received % (64 * MB) < chunk.value.byteLength) {
        peak = Math.max(peak, process.memoryUsage().rss - base);
      }
    }
    expect(received).toBe(BIG);
    expect(peak).toBeLessThan(200 * MB);
  }, 60_000);

  it('rejects forged tokens, foreign hosts, navigations and non-GET methods', async () => {
    const service = new MediaStreamService({ remoteFs: () => Promise.reject(new Error('no')) });
    const opened = await service.open(localRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);
    const token = opened.data.token;
    const forged = `${MEDIA_STREAM_SCHEME}://media/${token.slice(0, -2)}AA`;
    expect((await service.handle(request(forged))).status).toBe(404);
    expect((await service.handle(request(`${MEDIA_STREAM_SCHEME}://other/${token}`))).status).toBe(
      404
    );
    expect(
      (await service.handle(request(`${MEDIA_STREAM_SCHEME}://media/${token}?x=1`))).status
    ).toBe(404);
    expect(
      (await service.handle(request(`${MEDIA_STREAM_SCHEME}://media/${token}/..%2Fetc`))).status
    ).toBe(404);
    expect(
      (await service.handle(request(opened.data.url, { 'Sec-Fetch-Dest': 'document' }))).status
    ).toBe(403);
    expect(
      (await service.handle(request(opened.data.url, { 'Sec-Fetch-Dest': 'iframe' }))).status
    ).toBe(403);
    expect((await service.handle(request(opened.data.url, {}, 'POST'))).status).toBe(405);
    const video = await service.handle(
      request(opened.data.url, { 'Sec-Fetch-Dest': 'video', Range: 'bytes=0-3' })
    );
    expect(video.status).toBe(206);
    await video.body?.cancel();

    service.release(token);
    expect((await service.handle(request(opened.data.url))).status).toBe(404);
  });

  it('only mints tokens for media/PDF files outside sensitive locations', async () => {
    const service = new MediaStreamService({ remoteFs: () => Promise.reject(new Error('no')) });
    await writeFile(join(dir, 'notes.txt'), 'secret');
    await mkdir(join(dir, '.ssh'), { recursive: true });
    await writeFile(join(dir, '.ssh', 'clip.mp4'), 'x');
    await symlink(join(dir, 'notes.txt'), join(dir, 'disguised.mp4'));
    await writeFile(join(dir, 'doc.pdf'), '%PDF-1.4');

    expect(await service.open(localRef(join(dir, 'notes.txt')))).toMatchObject({
      success: false,
      error: { type: 'unsupported' },
    });
    expect(await service.open(localRef(join(dir, '.ssh', 'clip.mp4')))).toMatchObject({
      success: false,
      error: { type: 'forbidden' },
    });
    // Sembolik bağ gerçek yola çözülür; hedef medya değilse belirteç yok.
    expect(await service.open(localRef(join(dir, 'disguised.mp4')))).toMatchObject({
      success: false,
      error: { type: 'unsupported' },
    });
    expect(await service.open(localRef(join(dir, 'missing.mp4')))).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    expect(await service.open(localRef('/etc/hosts.mp4'))).toMatchObject({
      success: false,
      error: { type: 'forbidden' },
    });
    expect(await service.open(localRef(join(dir, 'doc.pdf')))).toMatchObject({
      success: true,
      data: { mimeType: 'application/pdf', size: 8 },
    });
  });

  it('saves a copy by streaming to the picked path', async () => {
    const target = join(dir, 'saved.mp4');
    const small = join(dir, 'clip.webm');
    await writeFile(small, Buffer.from('webm-bytes'));
    const service = new MediaStreamService({
      remoteFs: () => Promise.reject(new Error('no')),
      pickSavePath: async (name) => {
        expect(name).toBe('clip.webm');
        return target;
      },
    });
    await expect(service.saveCopy(localRef(small))).resolves.toEqual(ok({ path: target }));
    expect((await readFile(target)).toString()).toBe('webm-bytes');

    const cancelled = new MediaStreamService({
      remoteFs: () => Promise.reject(new Error('no')),
      pickSavePath: async () => undefined,
    });
    await expect(cancelled.saveCopy(localRef(small))).resolves.toEqual(ok({}));
  });
});
