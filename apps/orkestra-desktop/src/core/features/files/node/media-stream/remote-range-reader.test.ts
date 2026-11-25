import { hostRef } from '@orkestra/core/primitives/host/api';
import {
  formatAbsolute,
  parseAbsolute,
  type HostAbsolutePath,
} from '@orkestra/core/primitives/path/api';
import { err, ok } from '@orkestra/shared';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteFileRangeReader } from './remote-range-reader';

const HOST = hostRef('remote', 'conn-remote');
const VIDEO = '/home/u/out/reel.mp4';
const LINK = '/home/u/latest.mp4';

function absolute(path: string): HostAbsolutePath {
  const parsed = parseAbsolute(path);
  if (!parsed.success) throw new Error(`bad path ${path}`);
  return parsed.data;
}

/** Sahte uzak files runtime: `legacy` iken `offset` yok sayılır (eski workspace-server). */
function fakeRuntime(content: Buffer, options: { legacy?: boolean; chunk?: number } = {}) {
  const chunk = options.chunk ?? 1000;
  const readBytes = vi.fn(
    async (input: { path: HostAbsolutePath; options?: { offset?: number; length?: number } }) => {
      if (formatAbsolute(input.path) !== VIDEO) return err({ type: 'not-found' });
      const honoured = !options.legacy && input.options?.offset !== undefined;
      const start = honoured ? Math.min(input.options!.offset!, content.length) : 0;
      const end = honoured
        ? Math.min(content.length, start + (input.options?.length ?? content.length))
        : content.length;
      const cancel = vi.fn();
      return ok({
        meta: {
          name: 'reel.mp4',
          mimeType: 'video/mp4',
          size: end - start,
          truncated: false,
          totalSize: content.length,
          etag: 'e',
          ...(honoured ? { offset: start } : {}),
        },
        async *chunks() {
          for (let at = start; at < end; at += chunk) {
            yield new Uint8Array(content.subarray(at, Math.min(end, at + chunk)));
          }
        },
        cancel,
      });
    }
  );
  const runtime = {
    getHomeDir: async () => ({ path: absolute('/home/u') }),
    fs: {
      realPath: async ({ path }: { path: HostAbsolutePath }) => {
        const native = formatAbsolute(path);
        if (native === LINK) return ok({ path: absolute(VIDEO) });
        if (native === VIDEO) return ok({ path });
        return err({ type: 'not-found' });
      },
      stat: async ({ path }: { path: HostAbsolutePath }) =>
        formatAbsolute(path) === VIDEO
          ? ok({ type: 'file' as const, size: content.length })
          : err({ type: 'not-found' }),
      readBytes,
    },
  };
  return { runtime, readBytes };
}

const content = Buffer.from(Array.from({ length: 10_000 }, (_, i) => (i * 7) % 256));

describe('createRemoteFileRangeReader', () => {
  it('resolves symlinks and reads exactly the requested range with a ranged read', async () => {
    const { runtime, readBytes } = fakeRuntime(content);
    const reader = createRemoteFileRangeReader({ files: async () => runtime as never });
    await expect(reader.resolve(HOST, LINK)).resolves.toEqual({
      realPath: VIDEO,
      size: content.length,
    });
    const bytes = await reader.read(HOST, VIDEO, { offset: 4321, length: 2500 });
    expect(Buffer.from(bytes)).toEqual(content.subarray(4321, 6821));
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(readBytes.mock.calls[0]?.[0].options).toMatchObject({ offset: 4321, length: 2500 });
    await expect(reader.homeDirectory(HOST)).resolves.toBe('/home/u');
  });

  it('skips to the offset when an old server streams from byte 0 and no SFTP is available', async () => {
    const { runtime } = fakeRuntime(content, { legacy: true, chunk: 777 });
    const reader = createRemoteFileRangeReader({
      files: async () => runtime as never,
      sftp: async () => undefined,
    });
    const bytes = await reader.read(HOST, VIDEO, { offset: 9000, length: 5000 });
    expect(Buffer.from(bytes)).toEqual(content.subarray(9000));
  });

  it('reports a missing file as not-found and an unreachable host as unavailable', async () => {
    const { runtime } = fakeRuntime(content);
    const reader = createRemoteFileRangeReader({ files: async () => runtime as never });
    await expect(reader.resolve(HOST, '/home/u/missing.mp4')).rejects.toMatchObject({
      type: 'not-found',
    });
    const offline = createRemoteFileRangeReader({
      files: async () => {
        throw new Error('ssh down');
      },
    });
    await expect(offline.resolve(HOST, VIDEO)).rejects.toMatchObject({ type: 'unavailable' });
  });
});
