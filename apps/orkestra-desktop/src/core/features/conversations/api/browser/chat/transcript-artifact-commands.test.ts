import { encodeResourceUri } from '@orkestra/core/primitives/path/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import { createTranscriptArtifactResolver } from './transcript-artifact-commands';

const mocks = vi.hoisted(() => ({
  readBytes: vi.fn(),
  workspace: { path: '/home/dev/project', sshConnectionId: 'ssh-1' },
}));
vi.mock('@core/features/files/api/browser/client', () => ({
  getFilesClient: async () => ({ fs: { readBytes: mocks.readBytes } }),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: () => ({ workspaceId: 'workspace-1' }),
  asProvisioned: (value: unknown) => value,
}));
vi.mock('@core/features/workspaces/api/browser/stores/workspace-registry', () => ({
  workspaceRegistry: { get: () => mocks.workspace },
}));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.readBytes.mockReset();
});

const resolve = createTranscriptArtifactResolver({ projectId: 'project', taskId: 'task' });

function download(totalSize = 3, truncated = false) {
  return {
    success: true,
    data: {
      meta: { totalSize, truncated, mimeType: 'image/png' },
      chunks: async function* () {
        yield new Uint8Array([1, 2, 3]);
      },
      cancel: vi.fn(),
    },
  };
}

describe('transcript artifact host resolution', () => {
  it.each([
    ['out/cat.png', '/home/dev/project/out/cat.png'],
    ['/tmp/cat.png', '/tmp/cat.png'],
    ['file:///tmp/cat%20photo.png', '/tmp/cat photo.png'],
    ['sandbox:/mnt/data/cat.png', '/mnt/data/cat.png'],
  ])('reads %s on the task host and releases its object URL', async (uri, path) => {
    mocks.readBytes.mockResolvedValue(download());
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const result = await resolve({ uri, name: 'Cat' });
    expect(mocks.readBytes).toHaveBeenCalledWith(
      {
        uri: encodeResourceUri(hostFileRefFromNativePath(path, 'ssh-1')),
        options: { stream: true, maxBytes: 512 * 1024 * 1024 },
      },
      { signal: undefined }
    );
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    result.dispose?.();
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('cancels truncated transfers and explains old remote runtime limits', async () => {
    const result = download(101 * 1024 * 1024, true);
    mocks.readBytes.mockResolvedValue(result);
    await expect(resolve({ uri: '/tmp/movie.mp4', name: 'Movie' })).rejects.toThrow(
      'Uzak makinenin'
    );
    expect(result.data.cancel).toHaveBeenCalledOnce();
  });

  it('rejects foreign file authorities and executable schemes before reading', async () => {
    await expect(resolve({ uri: 'file://other-host/tmp/cat.png', name: 'Cat' })).rejects.toThrow(
      'desteklenmiyor'
    );
    await expect(resolve({ uri: 'javascript:alert(1)', name: 'Cat' })).rejects.toThrow(
      'desteklenmiyor'
    );
    expect(mocks.readBytes).not.toHaveBeenCalled();
  });
});
