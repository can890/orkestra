import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseAbsolute } from '@orkestra/core/primitives/path/api';
import { filesContract } from '@orkestra/core/runtimes/files/api';
import { createFilesController, FilesRuntime } from '@orkestra/core/runtimes/files/node';
import type { IWatchService } from '@orkestra/core/services/fs-watch/api';
import { workspaceWireContract } from '@orkestra/core/workspace-server';
import { ok } from '@orkestra/shared';
import { client as createClient, connect, serve, streamTransport } from '@orkestra/wire/rpc';
import { createTestWire } from '@orkestra/wire/testing';
import { describe, expect, it } from 'vitest';
import { createTestWorkspaceWireController } from '../testing/controller';

// Uzak masaüstü medya akışı: `offset` seçeneği workspace-server üzerinden ikili akış
// çerçeveleriyle (SSH yolundaki streamTransport) uçtan uca taşınmalı.
describe('workspace-server files range reads', () => {
  it('serves an offset range over the binary stream transport and echoes the offset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-ws-range-'));
    const file = join(directory, 'render.mp4');
    await writeFile(file, '');
    const total = 700 * 1024 * 1024;
    await truncate(file, total);
    const tail = Buffer.from('tail-bytes');
    const handle = await open(file, 'r+');
    await handle.write(tail, 0, tail.length, total - tail.length);
    await handle.close();
    const filePath = parseAbsolute(file);
    if (!filePath.success) throw new Error('expected test path to parse');

    const filesRuntime = new FilesRuntime({ watcher: noopWatcher() });
    const files = createTestWire(filesContract, createFilesController(filesRuntime));
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const disposeServer = serve(
      streamTransport(clientToServer, serverToClient),
      createTestWorkspaceWireController({ files: files.client })
    );
    const transport = streamTransport(serverToClient, clientToServer);
    const wireClient = createClient(workspaceWireContract, connect(transport));

    try {
      const range = await wireClient.files.fs.readBytes({
        path: filePath.data,
        options: { stream: true, offset: total - tail.length },
      });
      expect(range.success).toBe(true);
      if (!range.success) return;
      expect(range.data.meta).toMatchObject({
        offset: total - tail.length,
        size: tail.length,
        totalSize: total,
      });
      await expect(range.data.bytes()).resolves.toEqual(new Uint8Array(tail));

      // Ofsetsiz akış eski davranışı korur: yankı yok, önizleme sınırı geçerli.
      const legacy = await wireClient.files.fs.readBytes({
        path: filePath.data,
        options: { stream: true },
      });
      expect(legacy.success).toBe(true);
      if (!legacy.success) return;
      expect(legacy.data.meta.offset).toBeUndefined();
      expect(legacy.data.meta.truncated).toBe(true);
      legacy.data.cancel();
    } finally {
      disposeServer();
      transport.close?.();
      await files.dispose();
      await filesRuntime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function noopWatcher(): IWatchService {
  return {
    watch: () => ({
      ready: async () => ok(undefined),
      release: async () => {},
    }),
    dispose: async () => {},
  };
}
