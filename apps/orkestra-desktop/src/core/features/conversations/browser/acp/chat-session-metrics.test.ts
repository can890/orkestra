import type { TranscriptTurn } from '@orkestra/chat-ui';
import { describe, expect, it } from 'vitest';
import { computeTranscriptStats, resolveSessionWorkDisplay } from './chat-session-metrics-model';

const BASE = 1_795_600_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function makeTurn(overrides: Partial<TranscriptTurn> & { id: string; seq: number }): TranscriptTurn {
  return {
    initiator: 'user',
    items: [],
    ...overrides,
  };
}

describe('computeTranscriptStats', () => {
  it('never treats replayed committed turns without outcome as still running', () => {
    const nineHoursAgo = BASE - (9 * HOUR + 43 * MIN);
    const committed: TranscriptTurn[] = [
      makeTurn({
        id: 't0',
        seq: 0,
        startedAt: nineHoursAgo,
        completedAt: nineHoursAgo + 45_000,
        // Replayed history turns have no explicit `outcome`.
        items: [
          { kind: 'message', id: 'm0', seq: 0, role: 'user', text: 'merhaba', createdAt: nineHoursAgo },
          {
            kind: 'message',
            id: 'm1',
            seq: 1,
            role: 'assistant',
            text: 'selam',
            createdAt: nineHoursAgo + 45_000,
          },
        ],
      }),
      makeTurn({
        id: 't1',
        seq: 1,
        startedAt: BASE - 2 * HOUR,
        completedAt: BASE - 2 * HOUR + 30_000,
        items: [
          { kind: 'message', id: 'm2', seq: 0, role: 'user', text: 'devam', createdAt: BASE - 2 * HOUR },
          {
            kind: 'message',
            id: 'm3',
            seq: 1,
            role: 'assistant',
            text: 'tamam',
            createdAt: BASE - 2 * HOUR + 30_000,
          },
        ],
      }),
    ];

    const activeTurn = makeTurn({
      id: 't2',
      seq: 2,
      startedAt: BASE - 12_000,
      items: [{ kind: 'message', id: 'm4', seq: 0, role: 'user', text: 'yeni is', createdAt: BASE - 12_000 }],
    });

    const stats = computeTranscriptStats(committed, activeTurn, true, BASE);

    expect(stats.activeWorkMs).toBe(12_000);
    expect(stats.completedWorkMs).toBe(75_000);
    expect(stats.totalWorkMs).toBe(87_000);
  });

  it('ignores stale implicit completedAt when a committed turn without outcome was closed hours later', () => {
    const morning = BASE - (9 * HOUR + 43 * MIN);
    const committed: TranscriptTurn[] = [
      makeTurn({
        id: 't0',
        seq: 0,
        startedAt: morning,
        // Implicitly closed 9h 43m later when user sent next prompt.
        completedAt: BASE,
        items: [
          { kind: 'message', id: 'm0', seq: 0, role: 'user', text: 'ilk', createdAt: morning },
          {
            kind: 'message',
            id: 'm1',
            seq: 1,
            role: 'assistant',
            text: 'bitti',
            createdAt: morning + 25_000,
          },
        ],
      }),
    ];

    const stats = computeTranscriptStats(committed, null, false, BASE);

    expect(stats.activeWorkMs).toBeNull();
    expect(stats.completedWorkMs).toBe(25_000);
    expect(stats.totalWorkMs).toBe(25_000);
    expect(stats.lastActivityAt).toBe(morning + 25_000);
  });

  it('does not cross-pair an old item timestamp with a replay completedAt', () => {
    const morning = BASE - 8 * HOUR;
    const committed: TranscriptTurn[] = [
      makeTurn({
        id: 't0',
        seq: 0,
        // Missing turn.startedAt, but completedAt stamped during replay hours later.
        completedAt: BASE,
        items: [{ kind: 'message', id: 'm0', seq: 0, role: 'user', text: 'tek mesaj', createdAt: morning }],
      }),
    ];

    const stats = computeTranscriptStats(committed, null, false, BASE);
    expect(stats.completedWorkMs).toBe(0);
    expect(stats.totalWorkMs).toBe(0);
  });

  it('returns null activeWorkMs when idle even if an activeTurn snapshot is lingering', () => {
    const activeTurn = makeTurn({
      id: 't0',
      seq: 0,
      startedAt: BASE - 5 * HOUR,
      items: [{ kind: 'message', id: 'm0', seq: 0, role: 'user', text: 'eski', createdAt: BASE - 5 * HOUR }],
    });

    const stats = computeTranscriptStats([], activeTurn, false, BASE);
    expect(stats.activeWorkMs).toBeNull();
    expect(stats.totalWorkMs).toBe(0);
  });

  it('returns null activeWorkMs when activeTurn has synthetic replay timestamp instead of real epoch', () => {
    const activeTurn = makeTurn({
      id: 't0',
      seq: 0,
      startedAt: 1,
      items: [],
    });

    const stats = computeTranscriptStats([], activeTurn, true, BASE);
    expect(stats.activeWorkMs).toBeNull();
  });
});

describe('resolveSessionWorkDisplay', () => {
  it('never falls back to historical totalWorkMs or diskWorkDurationMs while working', () => {
    const display = resolveSessionWorkDisplay({
      isWorking: true,
      transcriptStats: {
        completedWorkMs: 3 * HOUR,
        activeWorkMs: 0,
      },
      localActiveWorkMs: 500,
      diskWorkDurationMs: 9 * HOUR + 43 * MIN,
    });

    expect(display.activeWorkMs).toBe(0);
    expect(display.displayWorkMs).toBe(0);
    expect(display.label).toBe('Çalışıyor');
    expect(display.totalWorkMs).toBe(9 * HOUR + 43 * MIN);
  });

  it('uses localActiveWorkMs while working when activeTurnSnapshot is not available yet', () => {
    const display = resolveSessionWorkDisplay({
      isWorking: true,
      transcriptStats: {
        completedWorkMs: 2 * HOUR,
        activeWorkMs: null,
      },
      localActiveWorkMs: 14_000,
      diskWorkDurationMs: 4 * HOUR,
    });

    expect(display.displayWorkMs).toBe(14_000);
    expect(display.label).toBe('14sn çalışıyor');
  });

  it('shows cumulative total duration without working suffix when idle', () => {
    const display = resolveSessionWorkDisplay({
      isWorking: false,
      transcriptStats: {
        completedWorkMs: 125_000,
        activeWorkMs: null,
      },
      localActiveWorkMs: 0,
    });

    expect(display.hasWork).toBe(true);
    expect(display.label).toBe('2dk 5sn');
  });
});
