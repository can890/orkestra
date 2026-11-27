/**
 * Mobile Turn Fold — Collapses intermediate assistant updates, thinking steps,
 * and completed tool calls above the final assistant reply on completed turns,
 * matching Sovra Desktop & T3 Code behavior.
 */

import type { TranscriptEntry } from './mappers';

export type MobileDisplayRow =
  | { kind: 'entry'; entry: TranscriptEntry }
  | {
      kind: 'turn-fold';
      id: string;
      label: string;
      durationMs?: number;
      hiddenEntries: TranscriptEntry[];
      expanded: boolean;
    };

/**
 * Canlı çalışma/düşünme satırı için kısa Türkçe süre biçimi (örn. `12sn`, `1d 3sn`, `1sa 4d`).
 */
export function formatCompactElapsed(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) {
    return undefined;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}sn`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}d ${seconds}sn` : `${totalMinutes}d`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}sa ${minutes}d` : `${hours}sa`;
}

/**
 * Tamamlanan tur katlama satırı için okunabilir Türkçe süre biçimi (örn. `12 sn`, `1 dk 3 sn`, `1 sa 4 dk`).
 */
export function formatTurnFoldDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) {
    return undefined;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sn`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes} dk ${seconds} sn` : `${totalMinutes} dk`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} sa ${minutes} dk` : `${hours} sa`;
}

function isElicitationAnswerEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role === 'user' &&
    (entry.isElicitationAnswer === true || entry.id.startsWith('elicit-'))
  );
}

function isUserEntry(entry: TranscriptEntry): boolean {
  return entry.kind === 'message' && entry.role === 'user';
}

function isTurnBoundaryUserEntry(entry: TranscriptEntry): boolean {
  return isUserEntry(entry) && !isElicitationAnswerEntry(entry);
}

function isAssistantMessage(entry: TranscriptEntry): boolean {
  return entry.kind === 'message' && entry.role === 'assistant' && entry.text.trim().length > 0;
}

function isFoldExemptEntry(entry: TranscriptEntry, isActiveTurn: boolean): boolean {
  if (isUserEntry(entry)) return true;
  if (isActiveTurn && entry.kind === 'plan') return true;
  if (entry.kind === 'plan' && entry.streaming) return true;
  if (entry.kind === 'notice' && entry.tone === 'error') return true;
  if (entry.kind === 'tool' && (entry.status === 'running' || entry.status === 'failed')) {
    return true;
  }
  return false;
}

function extractMobileTurnDurationMs(turnEntries: readonly TranscriptEntry[]): number | undefined {
  let explicitStart: number | undefined;
  let explicitEnd: number | undefined;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  let thinkingDurationSum = 0;

  for (const item of turnEntries) {
    if (
      explicitStart === undefined &&
      typeof item.turnStartedAt === 'number' &&
      Number.isFinite(item.turnStartedAt)
    ) {
      explicitStart = item.turnStartedAt;
    }
    if (
      explicitEnd === undefined &&
      typeof item.turnCompletedAt === 'number' &&
      Number.isFinite(item.turnCompletedAt)
    ) {
      explicitEnd = item.turnCompletedAt;
    }
    if (item.kind === 'message' && typeof item.createdAt === 'number' && item.createdAt > 0) {
      if (item.createdAt < minTs) minTs = item.createdAt;
      if (item.createdAt > maxTs) maxTs = item.createdAt;
    } else if (item.kind === 'thinking') {
      if (typeof item.startedAt === 'number' && item.startedAt > 0) {
        if (item.startedAt < minTs) minTs = item.startedAt;
        const end = item.startedAt + (item.durationMs ?? 0);
        if (end > maxTs) maxTs = end;
      }
      if (typeof item.durationMs === 'number' && item.durationMs > 0) {
        thinkingDurationSum += item.durationMs;
      }
    }
  }

  if (explicitStart !== undefined && explicitEnd !== undefined && explicitEnd > explicitStart) {
    const diff = explicitEnd - explicitStart;
    if (diff >= 1000) return diff;
  }
  if (Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs - minTs >= 1000) {
    return maxTs - minTs;
  }
  if (thinkingDurationSum >= 1000) {
    return thinkingDurationSum;
  }
  return undefined;
}

function formatMobileFoldLabel(hidden: readonly TranscriptEntry[], durationMs?: number): string {
  let msgCount = 0;
  let toolCount = 0;
  let thinkCount = 0;
  for (const item of hidden) {
    if (item.kind === 'message' && item.role === 'assistant') msgCount += 1;
    else if (item.kind === 'tool' || item.kind === 'plan') toolCount += 1;
    else if (item.kind === 'thinking') thinkCount += 1;
  }
  const parts: string[] = [];
  if (msgCount > 0) parts.push(`${msgCount} ara mesaj`);
  if (toolCount > 0) parts.push(`${toolCount} araç`);
  if (thinkCount > 0 && parts.length === 0) parts.push(`${thinkCount} düşünme`);
  const duration = formatTurnFoldDuration(durationMs);
  if (duration) {
    return parts.length > 0 ? `${duration} çalıştı · ${parts.join(' · ')}` : `${duration} çalıştı`;
  }
  return parts.length > 0 ? `${parts.join(' · ')} (özetlendi)` : `${hidden.length} ara adım`;
}

export function foldMobileEntries(
  entries: readonly TranscriptEntry[],
  options: {
    isWorking: boolean;
    searchActive: boolean;
    expandedFoldIds: ReadonlySet<string>;
  }
): MobileDisplayRow[] {
  if (options.searchActive || entries.length === 0) {
    return entries.map((entry) => ({ kind: 'entry', entry }));
  }

  // Split entries into turns starting at each user message (excluding elicitation Q&A answers)
  const turns: TranscriptEntry[][] = [];
  for (const entry of entries) {
    if (isTurnBoundaryUserEntry(entry) || turns.length === 0) {
      turns.push([entry]);
    } else {
      turns[turns.length - 1]!.push(entry);
    }
  }

  const rows: MobileDisplayRow[] = [];
  turns.forEach((turnEntries, turnIdx) => {
    const isActiveTurn = options.isWorking && turnIdx === turns.length - 1;
    if (isActiveTurn) {
      for (const entry of turnEntries) rows.push({ kind: 'entry', entry });
      return;
    }

    // Find terminal assistant reply in this completed turn
    let terminalIdx = -1;
    for (let i = turnEntries.length - 1; i >= 0; i--) {
      if (isAssistantMessage(turnEntries[i]!)) {
        terminalIdx = i;
        break;
      }
    }

    if (terminalIdx <= 0) {
      for (const entry of turnEntries) rows.push({ kind: 'entry', entry });
      return;
    }

    const foldable: TranscriptEntry[] = [];
    const foldableSet = new Set<number>();
    for (let i = 0; i < terminalIdx; i++) {
      const entry = turnEntries[i]!;
      if (isFoldExemptEntry(entry, false)) continue;
      foldable.push(entry);
      foldableSet.add(i);
    }

    if (foldable.length === 0) {
      for (const entry of turnEntries) rows.push({ kind: 'entry', entry });
      return;
    }

    const foldId = `mfold:${turnEntries[0]!.id}`;
    const expanded = options.expandedFoldIds.has(foldId);
    const durationMs = extractMobileTurnDurationMs(turnEntries);
    let inserted = false;

    for (let i = 0; i < turnEntries.length; i++) {
      const entry = turnEntries[i]!;
      if (foldableSet.has(i)) {
        if (!inserted) {
          rows.push({
            kind: 'turn-fold',
            id: foldId,
            label: formatMobileFoldLabel(foldable, durationMs),
            ...(durationMs !== undefined ? { durationMs } : {}),
            hiddenEntries: foldable,
            expanded,
          });
          inserted = true;
        }
        if (expanded) {
          rows.push({ kind: 'entry', entry });
        }
        continue;
      }
      rows.push({ kind: 'entry', entry });
    }
  });

  return rows;
}
