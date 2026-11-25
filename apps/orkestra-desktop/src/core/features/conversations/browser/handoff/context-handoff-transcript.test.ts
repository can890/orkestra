import { describe, expect, it, vi } from 'vitest';
import {
  writeContextHandoffTranscript,
  type FsResult,
  type TranscriptFilesDeps,
} from './context-handoff-transcript';

function fakeFiles(
  homes: Record<string, string>,
  overrides: Partial<TranscriptFilesDeps> = {}
): TranscriptFilesDeps & {
  dirs: Array<{ path: string; connectionId: string | undefined }>;
  writes: Array<{ path: string; connectionId: string | undefined; content: string }>;
} {
  const dirs: Array<{ path: string; connectionId: string | undefined }> = [];
  const writes: Array<{ path: string; connectionId: string | undefined; content: string }> = [];
  return {
    dirs,
    writes,
    getHomeDir: vi.fn(
      async (connectionId: string | undefined) => homes[connectionId ?? 'local'] ?? ''
    ),
    createDirectory: async (input): Promise<FsResult> => {
      dirs.push(input);
      return { success: true };
    },
    writeText: async (input): Promise<FsResult> => {
      writes.push(input);
      return { success: true };
    },
    ...overrides,
  };
}

describe('writeContextHandoffTranscript', () => {
  it('writes local transcripts under the local home, outside the working tree', async () => {
    const files = fakeFiles({ local: '/Users/test' });
    const location = await writeContextHandoffTranscript(
      { connectionId: undefined, newConversationId: 'n1', markdown: '# döküm' },
      files
    );
    expect(location).toEqual({
      kind: 'written',
      path: '/Users/test/.orkestra/handoffs/n1.md',
      hostLabel: 'çalıştığın makinede',
      truncated: false,
    });
    expect(files.dirs.map((dir) => dir.path)).toEqual([
      '/Users/test/.orkestra',
      '/Users/test/.orkestra/handoffs',
    ]);
    expect(files.writes).toEqual([
      {
        path: '/Users/test/.orkestra/handoffs/n1.md',
        connectionId: undefined,
        content: '# döküm',
      },
    ]);
  });

  it('SSH host: resolves the remote home and writes through that host', async () => {
    const files = fakeFiles({ local: '/Users/test', 'ssh-remote': '/home/test' });
    const location = await writeContextHandoffTranscript(
      { connectionId: 'ssh-remote', newConversationId: 'n2', markdown: 'x' },
      files
    );
    expect(files.getHomeDir).toHaveBeenCalledWith('ssh-remote');
    expect(location).toMatchObject({
      kind: 'written',
      path: '/home/test/.orkestra/handoffs/n2.md',
    });
    expect(files.dirs.every((dir) => dir.connectionId === 'ssh-remote')).toBe(true);
    expect(files.writes[0]).toMatchObject({
      path: '/home/test/.orkestra/handoffs/n2.md',
      connectionId: 'ssh-remote',
    });
  });

  it('accepts already existing folders', async () => {
    const files = fakeFiles(
      { local: '/home/u' },
      {
        createDirectory: async () => ({
          success: false,
          error: { type: 'already-exists', path: '/home/u/.orkestra' },
        }),
      }
    );
    const location = await writeContextHandoffTranscript(
      { connectionId: undefined, newConversationId: 'n3', markdown: 'x' },
      files
    );
    expect(location.kind).toBe('written');
  });

  it('reports why the transcript is unavailable instead of throwing', async () => {
    const denied = fakeFiles(
      { local: '/home/u' },
      {
        writeText: async () => ({
          success: false,
          error: { type: 'permission-denied', path: '/home/u/.orkestra/handoffs/n4.md' },
        }),
      }
    );
    expect(
      await writeContextHandoffTranscript(
        { connectionId: undefined, newConversationId: 'n4', markdown: 'x' },
        denied
      )
    ).toEqual({ kind: 'unavailable', reason: 'dosya yazılamadı: permission-denied' });

    const offline = fakeFiles(
      {},
      {
        getHomeDir: async () => {
          throw new Error('host offline');
        },
      }
    );
    expect(
      await writeContextHandoffTranscript(
        { connectionId: 'ssh-x', newConversationId: 'n5', markdown: 'x' },
        offline
      )
    ).toEqual({ kind: 'unavailable', reason: 'host offline' });
  });
});
