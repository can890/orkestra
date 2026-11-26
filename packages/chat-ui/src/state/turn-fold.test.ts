import { describe, expect, it } from 'vitest';
import type { ChatCaches } from '@core/caches';
import type { ItemSegmenter, SegmentCtx } from '@core/units';
import { unit } from '@core/units';
import type { ToolCallVisibility, TranscriptTurn, TurnFoldItem } from '@/model';
import { flattenTier } from './flatten';
import { formatTurnFoldDuration, formatTurnFoldLabel } from './turn-fold';

const passthrough = (kind: string): ItemSegmenter => ({
  kind,
  segment: (item) => [unit(kind, item, item, { key: 'self' })],
});

const STUB_SEGMENTERS: Record<string, ItemSegmenter> = {
  message: passthrough('message'),
  'execute-tool-call': passthrough('execute'),
  thinking: passthrough('thinking'),
  working: passthrough('working'),
  'turn-outcome': passthrough('turn-outcome'),
  'turn-fold': passthrough('turn-fold'),
  'visit-watermark': passthrough('visit-watermark'),
};

function makeCtx(overrides: Partial<SegmentCtx> = {}): SegmentCtx {
  return {
    caches: {} as ChatCaches,
    expanded: () => false,
    active: false,
    plan: () => null,
    pendingToolCallIds: () => new Set(),
    artifactVisible: () => true,
    terminalOutput: () => null,
    autoCollapseCompletedTurns: () => true,
    toolCallVisibility: () => 'showAll',
    ...overrides,
  };
}

function multiStepTurn(overrides: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 1,
    initiator: 'user',
    startedAt: 1_000,
    completedAt: 103_000,
    outcome: { kind: 'done' },
    items: [
      { kind: 'message', id: 'u1', seq: 1, role: 'user', text: 'Bunu düzelt', createdAt: 1_000 },
      {
        kind: 'message',
        id: 'a1',
        seq: 2,
        role: 'assistant',
        text: 'Dosyaları inceliyorum...',
        createdAt: 5_000,
      },
      {
        kind: 'execute-tool-call',
        id: 't1',
        toolCallId: 'tc1',
        title: 'Run test',
        seq: 3,
        command: 'pnpm test',
        status: 'done',
      },
      {
        kind: 'message',
        id: 'a2',
        seq: 4,
        role: 'assistant',
        text: 'Sorunu buldum, düzeltiyorum...',
        createdAt: 50_000,
      },
      {
        kind: 'message',
        id: 'a3',
        seq: 5,
        role: 'assistant',
        text: 'Tamamlandı! Özet rapor burada.',
        createdAt: 103_000,
      },
    ],
    ...overrides,
  };
}

describe('turn-fold & ToolCallVisibility', () => {
  it('folds intermediate assistant messages and tools above final reply on completed turns', () => {
    const units = flattenTier([multiStepTurn()], makeCtx(), STUB_SEGMENTERS);
    expect(units.map((u) => `${u.kind}:${u.itemId}`)).toEqual([
      'message:u1',
      'turn-fold:turn-1:fold',
      'message:a3',
    ]);
    const fold = units[1]!.data as TurnFoldItem;
    expect(fold.expanded).toBe(false);
    expect(fold.intermediateMessageCount).toBe(2);
    expect(fold.toolStepCount).toBe(1);
    expect(formatTurnFoldLabel(fold)).toBe('1 dk 42 sn çalıştı');
  });

  it('reveals all intermediate steps when turnFoldExpanded is true', () => {
    const units = flattenTier(
      [multiStepTurn()],
      makeCtx({ turnFoldExpanded: (id) => id === 'turn-1:fold' }),
      STUB_SEGMENTERS
    );
    expect(units.map((u) => `${u.kind}:${u.itemId}`)).toEqual([
      'message:u1',
      'turn-fold:turn-1:fold',
      'message:a1',
      'execute:t1',
      'message:a2',
      'message:a3',
    ]);
  });

  it('auto-expands folded turn when Cmd+F reveals a matching intermediate item', () => {
    const units = flattenTier(
      [multiStepTurn()],
      makeCtx({ revealedItemIds: () => new Set(['a2']) }),
      STUB_SEGMENTERS
    );
    expect(units.some((u) => u.itemId === 'a2')).toBe(true);
    const fold = units.find((u) => u.kind === 'turn-fold')!.data as TurnFoldItem;
    expect(fold.expanded).toBe(true);
  });

  it('keeps active turns unfolded in showAll mode, and hides intermediate steps in zen mode', () => {
    const turn = multiStepTurn({ outcome: undefined });
    const liveShowAll = flattenTier([turn], makeCtx({ active: true }), STUB_SEGMENTERS);
    expect(liveShowAll.some((u) => u.itemId === 'a1')).toBe(true);
    expect(liveShowAll.some((u) => u.itemId === 't1')).toBe(true);

    const liveZen = flattenTier(
      [turn],
      makeCtx({ active: true, toolCallVisibility: () => 'zen' as ToolCallVisibility }),
      STUB_SEGMENTERS
    );
    expect(liveZen.map((u) => u.kind)).toEqual(['message', 'working']);
    expect(liveZen[0]!.itemId).toBe('u1');
  });

  it('never folds error turns or pending permission tool calls', () => {
    const errTurn = multiStepTurn({ outcome: { kind: 'error', message: 'Boom' } });
    const errUnits = flattenTier([errTurn], makeCtx(), STUB_SEGMENTERS);
    expect(errUnits.some((u) => u.kind === 'turn-fold')).toBe(false);

    const pendingUnits = flattenTier(
      [multiStepTurn()],
      makeCtx({ pendingToolCallIds: () => new Set(['t1']) }),
      STUB_SEGMENTERS
    );
    expect(pendingUnits.some((u) => u.itemId === 't1')).toBe(true);
  });

  it('renders visit-watermark after the specified turn id', () => {
    const units = flattenTier(
      [multiStepTurn()],
      makeCtx({ visitWatermarkAfterTurnId: () => 'turn-1' }),
      STUB_SEGMENTERS
    );
    expect(units.at(-1)?.kind).toBe('visit-watermark');
  });

  it('formats durations in Turkish without bogus 0 sn', () => {
    expect(formatTurnFoldDuration(400)).toBeUndefined();
    expect(formatTurnFoldDuration(42_000)).toBe('42 sn');
    expect(formatTurnFoldDuration(120_000)).toBe('2 dk');
    expect(formatTurnFoldDuration(3_720_000)).toBe('1 sa 2 dk');
  });

  it('prefers item timestamp span over stale implicit completedAt when outcome is absent', () => {
    const morning = 1_795_600_000_000;
    const nineHoursLater = morning + 9 * 3_600_000 + 43 * 60_000;
    const turn = multiStepTurn({
      outcome: undefined,
      startedAt: morning,
      completedAt: nineHoursLater,
      items: [
        { kind: 'message', id: 'u1', seq: 1, role: 'user', text: 'Bunu düzelt', createdAt: morning },
        {
          kind: 'message',
          id: 'a1',
          seq: 2,
          role: 'assistant',
          text: 'İnceliyorum...',
          createdAt: morning + 5_000,
        },
        {
          kind: 'execute-tool-call',
          id: 't1',
          toolCallId: 'tc1',
          title: 'Run test',
          seq: 3,
          command: 'pnpm test',
          status: 'done',
        },
        {
          kind: 'message',
          id: 'a3',
          seq: 4,
          role: 'assistant',
          text: 'Tamamlandı!',
          createdAt: morning + 42_000,
        },
      ],
    });
    const units = flattenTier([turn], makeCtx(), STUB_SEGMENTERS);
    const fold = units.find((u) => u.kind === 'turn-fold')!.data as TurnFoldItem;
    expect(fold.durationMs).toBe(42_000);
    expect(formatTurnFoldLabel(fold)).toBe('42 sn çalıştı');
  });
});
