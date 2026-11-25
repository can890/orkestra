import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LiveSource, LiveUpdate } from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeRemoteHistoryResult, wrapLiveSourceForRemote } from './remote-payload-guard';

describe('remote-payload-guard', () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-payload-guard-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('externalizes large inline base64 data URIs in loadHistory to cache files', () => {
    const cacheDir = makeTempDir();
    const bigPng = Buffer.alloc(64 * 1024, 0x42);
    const dataUri = `data:image/png;base64,${bigPng.toString('base64')}`;

    const result = sanitizeRemoteHistoryResult(
      {
        success: true,
        data: {
          turns: [
            {
              seq: 1,
              items: [
                {
                  kind: 'tool-call',
                  id: 't1',
                  artifacts: [{ uri: dataUri, name: 'Generated media', mimeType: 'image/png' }],
                },
              ],
            },
          ],
          nextCursor: null,
        },
      },
      { cacheDir }
    ) as {
      success: boolean;
      data: { turns: Array<{ items: Array<{ artifacts: Array<{ uri: string }> }> }> };
    };

    const rewrittenUri = result.data.turns[0]!.items[0]!.artifacts[0]!.uri;
    expect(rewrittenUri.startsWith(cacheDir)).toBe(true);
    expect(rewrittenUri.endsWith('.png')).toBe(true);
    expect(existsSync(rewrittenUri)).toBe(true);
    expect(readFileSync(rewrittenUri).equals(bigPng)).toBe(true);
  });

  it('trims oldest turns and updates nextCursor when history still exceeds byte budget', () => {
    const cacheDir = makeTempDir();
    const turns = Array.from({ length: 10 }, (_, idx) => ({
      seq: idx + 1,
      items: [{ kind: 'message', id: `m-${idx}`, role: 'assistant', text: 'a'.repeat(50_000) }],
    }));

    const result = sanitizeRemoteHistoryResult(
      {
        success: true,
        data: {
          turns,
          nextCursor: null,
          coverage: { fromSeq: null, beforeSeq: null },
        },
      },
      { cacheDir, maxHistoryBytes: 180_000 }
    ) as {
      success: boolean;
      data: { turns: Array<{ seq: number }>; nextCursor: number | null };
    };

    expect(result.data.turns.length).toBeGreaterThanOrEqual(1);
    expect(result.data.turns.length).toBeLessThan(10);
    expect(result.data.nextCursor).toBe(result.data.turns[0]!.seq);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(180_000);
  });

  it('sanitizes live session.state snapshots and update deltas without breaking structure', async () => {
    const cacheDir = makeTempDir();
    const bigJpg = Buffer.alloc(50 * 1024, 0x33);
    const dataUri = `data:image/jpeg;base64,${bigJpg.toString('base64')}`;

    let emitUpdate: ((u: LiveUpdate) => void) | null = null;
    const rawSource: LiveSource = {
      snapshot: () => ({
        generation: 1,
        sequence: 1,
        timestamp: 1000,
        data: { activeTurn: { items: [{ artifacts: [{ uri: dataUri }] }] } },
      }),
      subscribe: (cb) => {
        emitUpdate = cb;
        return () => {};
      },
    };

    const wrapped = wrapLiveSourceForRemote(
      'conversations.acp.session.state|{"conversationId":"c1"}',
      rawSource,
      { cacheDir }
    );
    const snap = await wrapped.snapshot();
    const snapUri = (
      snap.data as { activeTurn: { items: Array<{ artifacts: Array<{ uri: string }> }> } }
    ).activeTurn.items[0]!.artifacts[0]!.uri;
    expect(snapUri.startsWith(cacheDir)).toBe(true);
    expect(snapUri.endsWith('.jpg')).toBe(true);

    const updates: LiveUpdate[] = [];
    await wrapped.subscribe((u) => updates.push(u));
    emitUpdate!({
      generation: 1,
      baseSequence: 1,
      sequence: 2,
      timestamp: 1001,
      delta: { activeTurn: { artifacts: [{ uri: dataUri }] } },
    });
    const deltaUri = (updates[0]!.delta as { activeTurn: { artifacts: Array<{ uri: string }> } })
      .activeTurn.artifacts[0]!.uri;
    expect(deltaUri).toBe(snapUri);
  });
});
