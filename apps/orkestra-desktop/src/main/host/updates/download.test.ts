import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile, type DownloadOptions } from './download';

const PAYLOAD = Buffer.from('0123456789abcdefghij');
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-download-'));
  dirs.push(dir);
  return dir;
}

function streamOf(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== undefined && index === failAfter) {
        controller.error(new Error('socket hang up'));
        return;
      }
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function options(
  dir: string,
  fetch: DownloadOptions['fetch'],
  extra: Partial<DownloadOptions> = {}
): DownloadOptions {
  return {
    url: 'https://github.com/can890/orkestra/releases/download/v1.2.22/orkestra-arm64.zip',
    destination: join(dir, 'orkestra-arm64.zip'),
    expectedSize: PAYLOAD.length,
    userAgent: 'Orkestra/1.2.21',
    fetch,
    progressIntervalMs: 0,
    ...extra,
  };
}

describe('downloadFile', () => {
  it('streams to a .part file, reports progress and renames when complete', async () => {
    const dir = await tempDir();
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(streamOf([PAYLOAD.subarray(0, 10), PAYLOAD.subarray(10)]), {
          status: 200,
          headers: { 'content-length': String(PAYLOAD.length) },
        })
    );
    const onProgress = vi.fn();

    await downloadFile(options(dir, fetch, { onProgress }));

    expect(await readFile(join(dir, 'orkestra-arm64.zip'))).toEqual(PAYLOAD);
    await expect(stat(join(dir, 'orkestra-arm64.zip.part'))).rejects.toThrow();
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ percent: 100, transferred: 20, total: 20 })
    );
    expect(onProgress.mock.calls.some(([p]) => p.percent === 50)).toBe(true);
    const init = fetch.mock.calls[0]![1];
    expect(init.headers).toMatchObject({ 'User-Agent': 'Orkestra/1.2.21' });
    expect(init.headers).not.toHaveProperty('Range');
  });

  it('keeps a partial download and resumes it with a Range request', async () => {
    const dir = await tempDir();
    const first = vi.fn(
      async () => new Response(streamOf([PAYLOAD.subarray(0, 8), PAYLOAD.subarray(8)], 1))
    );
    await expect(downloadFile(options(dir, first))).rejects.toThrow('bağlantı koptu');
    expect((await stat(join(dir, 'orkestra-arm64.zip.part'))).size).toBe(8);
    await expect(stat(join(dir, 'orkestra-arm64.zip'))).rejects.toThrow();

    const resume = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(streamOf([PAYLOAD.subarray(8)]), {
          status: 206,
          headers: { 'content-range': 'bytes 8-19/20' },
        })
    );
    await downloadFile(options(dir, resume));
    expect(resume.mock.calls[0]![1].headers).toMatchObject({ Range: 'bytes=8-' });
    expect(await readFile(join(dir, 'orkestra-arm64.zip'))).toEqual(PAYLOAD);
  });

  it('starts over when the server ignores the Range header', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'orkestra-arm64.zip.part'), 'garbage');
    const fetch = vi.fn(async () => new Response(streamOf([PAYLOAD]), { status: 200 }));
    await downloadFile(options(dir, fetch));
    expect(await readFile(join(dir, 'orkestra-arm64.zip'))).toEqual(PAYLOAD);
  });

  it('restarts from zero when the range is not satisfiable', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'orkestra-arm64.zip.part'), 'abc');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 416 }))
      .mockResolvedValueOnce(new Response(streamOf([PAYLOAD]), { status: 200 }));
    await downloadFile(options(dir, fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(join(dir, 'orkestra-arm64.zip'))).toEqual(PAYLOAD);
  });

  it('never treats a short download as complete', async () => {
    const dir = await tempDir();
    const fetch = vi.fn(async () => new Response(streamOf([PAYLOAD.subarray(0, 5)])));
    await expect(downloadFile(options(dir, fetch))).rejects.toThrow('yarım kaldı (5 / 20 bayt)');
    await expect(stat(join(dir, 'orkestra-arm64.zip'))).rejects.toThrow();
  });

  it('skips the network when the complete file is already there', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'orkestra-arm64.zip'), PAYLOAD);
    const fetch = vi.fn();
    await downloadFile(options(dir, fetch));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explains offline and HTTP failures in Turkish', async () => {
    const dir = await tempDir();
    await expect(
      downloadFile(options(dir, vi.fn().mockRejectedValue(new TypeError('fetch failed'))))
    ).rejects.toThrow('bağlantı kurulamadı (fetch failed)');
    await expect(
      downloadFile(options(dir, vi.fn().mockResolvedValue(new Response('', { status: 404 }))))
    ).rejects.toThrow('HTTP 404');
  });

  it('aborts a stalled connection after the idle timeout', async () => {
    const dir = await tempDir();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PAYLOAD.subarray(0, 4));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream);
    });
    await expect(downloadFile(options(dir, fetch, { idleTimeoutMs: 20 }))).rejects.toThrow(
      'zaman aşımı'
    );
  });
});
