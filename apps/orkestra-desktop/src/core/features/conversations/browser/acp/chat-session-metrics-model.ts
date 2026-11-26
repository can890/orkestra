import type { TranscriptTurn } from '@orkestra/chat-ui';

export const REAL_EPOCH_MS = 1_000_000_000_000;

/** Örtük kapanmış (outcome yok) bir turda `completedAt` son öğeden bu kadar ilerideyse güvenilmez sayılır. */
const STALE_IMPLICIT_CLOSE_GAP_MS = 60_000;

export function isRealEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= REAL_EPOCH_MS;
}

export function formatWorkDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return mins > 0 ? `${hours}sa ${mins}dk` : `${hours}sa`;
  if (mins > 0) return secs > 0 ? `${mins}dk ${secs}sn` : `${mins}dk`;
  return `${secs}sn`;
}

function inspectTurnItems(turn: TranscriptTurn): {
  minItemTs: number | undefined;
  maxItemTs: number | undefined;
  thinkingDurationSum: number;
  chars: number;
} {
  let minItemTs: number | undefined;
  let maxItemTs: number | undefined;
  let thinkingDurationSum = 0;
  let chars = 0;

  for (const item of turn.items) {
    if (item.kind === 'message') {
      chars += item.text.length;
      const created =
        'createdAt' in item && isRealEpochMs(item.createdAt) ? item.createdAt : undefined;
      if (created !== undefined) {
        if (minItemTs === undefined || created < minItemTs) minItemTs = created;
        if (maxItemTs === undefined || created > maxItemTs) maxItemTs = created;
      }
    } else if (item.kind === 'thinking') {
      chars += item.text.length;
      if (isRealEpochMs(item.startedAt)) {
        if (minItemTs === undefined || item.startedAt < minItemTs) minItemTs = item.startedAt;
        const dur =
          typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs > 0
            ? item.durationMs
            : 0;
        const end = item.startedAt + dur;
        if (maxItemTs === undefined || end > maxItemTs) maxItemTs = end;
        thinkingDurationSum += dur;
      } else if (
        typeof item.durationMs === 'number' &&
        Number.isFinite(item.durationMs) &&
        item.durationMs > 0
      ) {
        thinkingDurationSum += item.durationMs;
      }
    } else if (item.kind === 'execute-tool-call' && item.outputText) {
      chars += Math.min(item.outputText.length, 4000);
    }
  }

  return { minItemTs, maxItemTs, thinkingDurationSum, chars };
}

/**
 * Tamamlanmış (`displayTurns`) bir turun gerçek çalışma süresini hesaplar.
 *
 * Kurallar:
 * - Tamamlanmış turlar `outcome` taşımasa bile (replay / örtük kapanış) ASLA `now - startedAt` ile
 *   canlı sayılmaz.
 * - Farklı kaynaklardan gelen damgalar çapraz eşleştirilmez (örn. eski mesaj `createdAt` ile
 *   replay anındaki `completedAt` çıkarılmaz).
 */
function computeCompletedTurnDurationMs(
  turn: TranscriptTurn,
  items: ReturnType<typeof inspectTurnItems>
): { durationMs: number; latestTs: number | undefined } {
  const started = isRealEpochMs(turn.startedAt) ? turn.startedAt : undefined;
  const completed = isRealEpochMs(turn.completedAt) ? turn.completedAt : undefined;
  const hasExplicitPair = started !== undefined && completed !== undefined && completed > started;
  const hasItemSpan =
    items.minItemTs !== undefined && items.maxItemTs !== undefined && items.maxItemTs > items.minItemTs;

  let durationMs = 0;
  if (turn.outcome !== undefined) {
    if (hasExplicitPair) {
      durationMs = completed - started;
    } else if (hasItemSpan) {
      durationMs = items.maxItemTs! - items.minItemTs!;
    } else if (items.thinkingDurationSum > 0) {
      durationMs = items.thinkingDurationSum;
    }
  } else {
    // Replay veya örtük kapanış: `completedAt` replay anı ya da saatler sonraki yeni mesajın
    // zamanı olabileceğinden öğe zaman aralığını önceliklendir.
    if (hasItemSpan) {
      durationMs = items.maxItemTs! - items.minItemTs!;
    } else if (
      hasExplicitPair &&
      (items.maxItemTs === undefined || completed - items.maxItemTs <= STALE_IMPLICIT_CLOSE_GAP_MS)
    ) {
      durationMs = completed - started;
    } else if (
      started !== undefined &&
      items.maxItemTs !== undefined &&
      items.maxItemTs > started
    ) {
      durationMs = items.maxItemTs - started;
    } else if (items.thinkingDurationSum > 0) {
      durationMs = items.thinkingDurationSum;
    }
  }

  const latestTs =
    turn.outcome !== undefined
      ? (completed ?? items.maxItemTs ?? started ?? items.minItemTs)
      : (items.maxItemTs ?? completed ?? started ?? items.minItemTs);

  return { durationMs, latestTs };
}

export function computeTranscriptStats(
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  isWorking: boolean,
  now: number
): {
  completedWorkMs: number;
  activeWorkMs: number | null;
  totalWorkMs: number;
  lastActivityAt: number | null;
  turnCount: number;
  estimatedTokens: number;
} {
  let completedWorkMs = 0;
  let lastActivityAt: number | null = null;
  let totalChars = 0;

  for (const turn of committedTurns) {
    const items = inspectTurnItems(turn);
    totalChars += items.chars;
    const { durationMs, latestTs } = computeCompletedTurnDurationMs(turn, items);
    completedWorkMs += durationMs;
    if (latestTs !== undefined && (lastActivityAt === null || latestTs > lastActivityAt)) {
      lastActivityAt = latestTs;
    }
  }

  let activeWorkMs: number | null = null;
  if (activeTurn) {
    const items = inspectTurnItems(activeTurn);
    totalChars += items.chars;

    if (isWorking) {
      // Yalnızca gerçek aktif turun kendi başlangıç damgasını kullan; eksikse bileşendeki
      // yerel başlangıç zamanına (workStartedAt) düşülmesi için null döndür.
      const started = isRealEpochMs(activeTurn.startedAt) ? activeTurn.startedAt : undefined;
      if (started !== undefined && started <= now) {
        activeWorkMs = Math.max(0, now - started);
      }
    }

    const latestInActive =
      items.maxItemTs ?? (isRealEpochMs(activeTurn.startedAt) ? activeTurn.startedAt : undefined);
    if (latestInActive !== undefined && (lastActivityAt === null || latestInActive > lastActivityAt)) {
      lastActivityAt = latestInActive;
    }
  }

  return {
    completedWorkMs,
    activeWorkMs,
    totalWorkMs: completedWorkMs + (activeWorkMs ?? 0),
    lastActivityAt,
    turnCount: committedTurns.length + (activeTurn ? 1 : 0),
    estimatedTokens: totalChars > 0 ? Math.max(1, Math.round(totalChars / 4)) : 0,
  };
}

export function resolveSessionWorkDisplay(params: {
  isWorking: boolean;
  transcriptStats: { completedWorkMs: number; activeWorkMs: number | null };
  localActiveWorkMs: number;
  diskWorkDurationMs?: number;
}): {
  activeWorkMs: number;
  totalWorkMs: number;
  displayWorkMs: number;
  hasWork: boolean;
  label: string;
} {
  const { isWorking, transcriptStats, localActiveWorkMs, diskWorkDurationMs } = params;
  // Çalışırken ASLA geçmiş toplam süreye (totalWorkMs / diskStats) düşme.
  const activeWorkMs = isWorking
    ? (transcriptStats.activeWorkMs ?? Math.max(0, localActiveWorkMs))
    : 0;
  const totalWorkMs = Math.max(
    transcriptStats.completedWorkMs + activeWorkMs,
    diskWorkDurationMs ?? 0
  );
  const displayWorkMs = isWorking ? activeWorkMs : totalWorkMs;
  const hasWork = isWorking || displayWorkMs >= 1_000;
  const label = isWorking
    ? displayWorkMs >= 1_000
      ? `${formatWorkDuration(displayWorkMs)} çalışıyor`
      : 'Çalışıyor'
    : formatWorkDuration(displayWorkMs);
  return { activeWorkMs, totalWorkMs, displayWorkMs, hasWork, label };
}
