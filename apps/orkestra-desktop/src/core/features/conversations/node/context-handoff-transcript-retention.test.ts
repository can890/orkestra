import { describe, expect, it, vi } from 'vitest';
import {
  parseRegistryTime,
  pruneContextHandoffTranscripts,
  selectTranscriptsToPrune,
  TRANSCRIPT_RETENTION_POLICY,
  transcriptConversationId,
  TranscriptRetentionScheduler,
  type TranscriptFileEntry,
  type TranscriptRetentionFiles,
} from './context-handoff-transcript-retention';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25);

function entry(id: string, ageDays: number): TranscriptFileEntry {
  return { name: `${id}.md`, conversationId: id, mtimeMs: NOW - ageDays * DAY };
}

function names(entries: readonly TranscriptFileEntry[]): string[] {
  return entries.map((e) => e.conversationId).sort();
}

describe('transcriptConversationId', () => {
  it('yalnızca bizim adlandırdığımız dökümleri tanır', () => {
    expect(transcriptConversationId('3b241101-e2bb-4255-8caf-4136c566a962.md')).toBe(
      '3b241101-e2bb-4255-8caf-4136c566a962'
    );
    expect(transcriptConversationId('notlarim.txt')).toBeNull();
    expect(transcriptConversationId('.md')).toBeNull();
    expect(transcriptConversationId('kisa.md')).toBeNull();
    expect(transcriptConversationId('../../etc-passwd.md')).toBeNull();
  });
});

describe('selectTranscriptsToPrune', () => {
  it('30 günden eskileri siler, gençlere dokunmaz', () => {
    const result = selectTranscriptsToPrune(
      [entry('conv-old-1', 45), entry('conv-mid-11', 10), entry('conv-new-11', 1)],
      { now: NOW, lastUsedAt: new Map() }
    );
    expect(names(result)).toEqual(['conv-old-1']);
  });

  it('halef sohbeti duran ve yakında kullanılmış dökümü asla silmez', () => {
    const result = selectTranscriptsToPrune([entry('conv-used-1', 90), entry('conv-idle-1', 90)], {
      now: NOW,
      lastUsedAt: new Map([
        ['conv-used-1', NOW - 2 * DAY],
        ['conv-idle-1', NOW - 60 * DAY],
      ]),
    });
    expect(names(result)).toEqual(['conv-idle-1']);
  });

  it('en yeni N dışında kalanları siler, ama 7 günden gençleri değil', () => {
    const policy = { ...TRANSCRIPT_RETENTION_POLICY, keepNewest: 2 };
    const result = selectTranscriptsToPrune(
      [
        entry('conv-a-111', 1),
        entry('conv-b-111', 2),
        entry('conv-c-111', 3),
        entry('conv-d-111', 8),
        entry('conv-e-111', 9),
      ],
      { now: NOW, lastUsedAt: new Map(), policy }
    );
    expect(names(result)).toEqual(['conv-d-111', 'conv-e-111']);
  });
});

function fakeFiles(files: Record<string, number>, options: { missingDir?: boolean } = {}) {
  const removed: string[] = [];
  const deps: TranscriptRetentionFiles = {
    homeDir: async () => '/home/u',
    list: vi.fn(async (dir: string) => {
      expect(dir).toBe('/home/u/.orkestra/handoffs');
      return options.missingDir ? null : Object.keys(files);
    }),
    mtimeMs: async (path) => files[path.slice('/home/u/.orkestra/handoffs/'.length)] ?? null,
    remove: async (path) => {
      removed.push(path);
      return true;
    },
  };
  return { deps, removed };
}

describe('pruneContextHandoffTranscripts', () => {
  it('ana makinenin handoffs klasöründe yalnızca kurala uyan dökümleri siler', async () => {
    const { deps, removed } = fakeFiles({
      'conv-old-111.md': NOW - 40 * DAY,
      'conv-kept-11.md': NOW - 40 * DAY,
      'conv-new-111.md': NOW - DAY,
      'README.txt': NOW - 400 * DAY,
      'alt/conv-deep-11.md': NOW - 400 * DAY,
    });
    const lastUsedAt = vi.fn(async (ids: readonly string[]) => {
      expect([...ids].sort()).toEqual(['conv-kept-11', 'conv-new-111', 'conv-old-111']);
      return new Map([['conv-kept-11', NOW - DAY]]);
    });
    const result = await pruneContextHandoffTranscripts({ files: deps, lastUsedAt, now: NOW });
    expect(removed).toEqual(['/home/u/.orkestra/handoffs/conv-old-111.md']);
    expect(result).toEqual({ scanned: 3, deleted: ['conv-old-111.md'], failed: [] });
  });

  it('klasör yoksa hiçbir şey yapmaz', async () => {
    const { deps, removed } = fakeFiles({}, { missingDir: true });
    const lastUsedAt = vi.fn(async () => new Map<string, number>());
    const result = await pruneContextHandoffTranscripts({ files: deps, lastUsedAt, now: NOW });
    expect(result.scanned).toBe(0);
    expect(removed).toEqual([]);
    expect(lastUsedAt).not.toHaveBeenCalled();
  });
});

describe('TranscriptRetentionScheduler', () => {
  it('ana makine başına seyreltir, ana makineleri birbirinden ayırır', async () => {
    let now = 0;
    const scheduler = new TranscriptRetentionScheduler(() => now, 1000);
    const run = vi.fn(async () => 'ok');
    expect(await scheduler.request('local', run)).toBe('ok');
    expect(await scheduler.request('local', run)).toBeNull();
    expect(await scheduler.request('remote:ssh-1', run)).toBe('ok');
    now = 1001;
    expect(await scheduler.request('local', run)).toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('süren temizlik varken ikinci isteği çalıştırmaz', async () => {
    const scheduler = new TranscriptRetentionScheduler(() => 0, 0);
    let release!: () => void;
    const slow = scheduler.request(
      'local',
      () => new Promise<void>((resolve) => (release = resolve))
    );
    expect(await scheduler.request('local', async () => 'second')).toBeNull();
    release();
    await slow;
  });
});

describe('parseRegistryTime', () => {
  it('ISO ve SQLite CURRENT_TIMESTAMP biçimlerini okur', () => {
    expect(parseRegistryTime('2026-11-25T10:00:00.000Z')).toBe(Date.UTC(2026, 10, 25, 10));
    expect(parseRegistryTime('2026-11-25 10:00:00')).toBe(Date.UTC(2026, 10, 25, 10));
    expect(parseRegistryTime(null)).toBeNull();
    expect(parseRegistryTime('bozuk')).toBeNull();
  });
});
