import { createReadStream } from 'node:fs';
import { mkdtemp, open, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRef, LOCAL_HOST_REF, type HostRef } from '@orkestra/core/primitives/host/api';
import {
  encodeResourceUri,
  hostFileRef,
  parseAbsolute,
  type HostFileRef,
} from '@orkestra/core/primitives/path/api';
import { filesContract, type FilesContract } from '@orkestra/core/runtimes/files/api';
import { createFilesController, FilesRuntime } from '@orkestra/core/runtimes/files/node';
import type { IWatchService } from '@orkestra/core/services/fs-watch/api';
import { ok } from '@orkestra/shared';
import {
  client,
  connect,
  memoryTransportPair,
  serve,
  type ContractClient,
} from '@orkestra/wire/rpc';
import { createTestWire } from '@orkestra/wire/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { filesWireContract } from '@core/features/files/api';
import { MediaStreamService } from '@core/features/files/node/media-stream/media-stream-service';
import {
  RangeCapabilityCache,
  type SftpRangeReader,
} from '@core/features/files/node/media-stream/sources';
import { createFilesWireController } from '@core/features/files/node/wire-controller';

// Lives at the gateway layer because it hosts a real files runtime (its node surface is off
// limits to feature slices). It plays the role of an SSH host's workspace-server: a current one
// that honours `offset`, and an old one that strips it, exactly as an older schema would.

const MB = 1024 * 1024;
const BIG = 600 * MB;
const TAIL = Buffer.from('<<render-tail>>');

let dir: string;
let bigFile: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'orkestra-media-gateway-')));
  bigFile = join(dir, 'render.mp4');
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

const disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function remoteRef(path: string, host: HostRef = hostRef('remote', 'huawei')): HostFileRef {
  const parsed = parseAbsolute(path);
  if (!parsed.success) throw new Error(`bad path ${path}`);
  return hostFileRef(host, parsed.data);
}

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

async function bodyText(response: Response): Promise<string> {
  return Buffer.from(await response.arrayBuffer()).toString('latin1');
}

function noopWatcher(): IWatchService {
  return {
    watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
    dispose: async () => {},
  };
}

type FilesClient = ContractClient<FilesContract>;

function realRemoteFiles(): FilesClient['fs'] {
  const runtime = new FilesRuntime({ watcher: noopWatcher(), idleTtlMs: 0 });
  const wire = createTestWire(filesContract, createFilesController(runtime));
  disposers.push(async () => {
    await wire.dispose();
    await runtime.dispose();
  });
  return wire.client.fs;
}

/** Old workspace-server: its schema strips `offset`/`length` and never echoes `offset`. */
function oldServer(fs: FilesClient['fs']): FilesClient['fs'] {
  return {
    ...fs,
    readBytes: (async (input, options) => {
      const { offset: _offset, length: _length, ...legacyOptions } = input.options ?? {};
      return fs.readBytes({ ...input, options: legacyOptions }, options);
    }) as FilesClient['fs']['readBytes'],
  };
}

function localSftp(): SftpRangeReader & { calls: number } {
  const reader = {
    calls: 0,
    createReadStream(path: string, options: { start: number; end: number }) {
      reader.calls += 1;
      return createReadStream(path, options);
    },
  };
  return reader;
}

describe('media stream through the files wire domain', () => {
  it('mints a token over Wire and serves a range of a 600 MB local file', async () => {
    const service = new MediaStreamService({ remoteFs: () => Promise.reject(new Error('no')) });
    const controller = createFilesWireController({
      runtimes: { client: () => Promise.reject(new Error('unused')) },
      media: service,
    });
    const pair = memoryTransportPair();
    const stop = serve(pair.right, controller);
    disposers.push(() => stop());
    const files = client(filesWireContract, connect(pair.left));
    const parsed = parseAbsolute(bigFile);
    if (!parsed.success) throw new Error('bad path');
    const uri = encodeResourceUri(hostFileRef(LOCAL_HOST_REF, parsed.data));

    const opened = await files.media.open({ uri });
    if (!opened.success) throw new Error(opened.error.message);
    expect(opened.data).toMatchObject({ size: BIG, mimeType: 'video/mp4' });

    const response = await service.handle(
      request(opened.data.url, { Range: `bytes=${BIG - TAIL.length}-` })
    );
    expect(response.status).toBe(206);
    expect(await bodyText(response)).toBe(TAIL.toString('latin1'));

    await files.media.release({ token: opened.data.token });
    expect((await service.handle(request(opened.data.url))).status).toBe(404);
  });
});

describe('MediaStreamService (SSH host)', () => {
  it('uses files-runtime offset reads when the remote server echoes the offset', async () => {
    const fs = realRemoteFiles();
    const readBytes = vi.spyOn(fs, 'readBytes');
    const sftp = localSftp();
    const service = new MediaStreamService({
      remoteFs: async () => fs,
      sftp: async () => sftp,
    });
    const opened = await service.open(remoteRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);
    expect(opened.data.size).toBe(BIG);

    const tail = await service.handle(request(opened.data.url, { Range: `bytes=${BIG - 15}-` }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${BIG - 15}-${BIG - 1}/${BIG}`);
    expect(await bodyText(tail)).toBe(TAIL.toString('latin1'));
    expect(readBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { stream: true, offset: BIG - 15, length: 15 },
      }),
      expect.anything()
    );
    expect(sftp.calls).toBe(0);
  });

  it('falls back to SFTP range reads when an old server ignores the offset', async () => {
    const fs = oldServer(realRemoteFiles());
    const sftp = localSftp();
    const capability = new RangeCapabilityCache();
    const service = new MediaStreamService({
      remoteFs: async () => fs,
      sftp: async () => sftp,
      capability,
    });
    const opened = await service.open(remoteRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);

    const tail = await service.handle(request(opened.data.url, { Range: `bytes=${BIG - 15}-` }));
    expect(tail.status).toBe(206);
    expect(tail.headers.get('accept-ranges')).toBe('bytes');
    expect(await bodyText(tail)).toBe(TAIL.toString('latin1'));
    expect(sftp.calls).toBe(1);
    expect(capability.isLegacy('remote:huawei')).toBe(true);

    // Öğrenilen durumla ikinci istek files runtime'ı hiç denemeden SFTP'ye gider.
    const readBytes = vi.spyOn(fs, 'readBytes');
    const headBytes = await service.handle(request(opened.data.url, { Range: 'bytes=0-3' }));
    expect(await bodyText(headBytes)).toBe('HEAD');
    expect(readBytes).not.toHaveBeenCalled();
    expect(sftp.calls).toBe(2);
  });

  it('streams sequentially from byte 0 when an old server has no SFTP either', async () => {
    const fs = oldServer(realRemoteFiles());
    const service = new MediaStreamService({
      remoteFs: async () => fs,
      sftp: async () => undefined,
    });
    const opened = await service.open(remoteRef(bigFile));
    if (!opened.success) throw new Error(opened.error.message);

    const response = await service.handle(request(opened.data.url, { Range: 'bytes=0-' }));
    // Aralık desteği bildirilmez: tarayıcı sıralı oynatır, arama yalnız tamponda çalışır.
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(response.headers.get('content-range')).toBeNull();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).subarray(0, 4).toString()).toBe('HEAD');
    await reader.cancel();

    const target = join(dir, 'legacy-copy.mp4');
    const saver = new MediaStreamService({
      remoteFs: async () => fs,
      sftp: async () => undefined,
      pickSavePath: async () => target,
    });
    await expect(saver.saveCopy(remoteRef(bigFile))).resolves.toMatchObject({
      success: false,
      error: { type: 'incomplete' },
    });
  });

  it('reports an unreachable host and applies path rules to the remote real path', async () => {
    const unreachable = new MediaStreamService({
      remoteFs: () => Promise.reject(new Error('offline')),
    });
    await expect(unreachable.open(remoteRef(bigFile))).resolves.toMatchObject({
      success: false,
      error: { type: 'unavailable' },
    });

    await writeFile(join(dir, 'notes.txt'), 'secret');
    await symlink(join(dir, 'notes.txt'), join(dir, 'disguised.mp4'));
    const fs = realRemoteFiles();
    const service = new MediaStreamService({ remoteFs: async () => fs });
    await expect(service.open(remoteRef(join(dir, 'disguised.mp4')))).resolves.toMatchObject({
      success: false,
      error: { type: 'unsupported' },
    });
  });
});
