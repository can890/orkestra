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
      hiddenEntries: TranscriptEntry[];
      expanded: boolean;
    };

function isUserEntry(entry: TranscriptEntry): boolean {
  return entry.kind === 'message' && entry.role === 'user';
}

function isAssistantMessage(entry: TranscriptEntry): boolean {
  return entry.kind === 'message' && entry.role === 'assistant' && entry.text.trim().length > 0;
}

function isFoldExemptEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === 'error' || entry.kind === 'outcome') return true;
  if (entry.kind === 'tool' && (entry.status === 'running' || entry.status === 'error')) return true;
  return false;
}

function formatMobileFoldLabel(hidden: readonly TranscriptEntry[]): string {
  let msgCount = 0;
  let toolCount = 0;
  let thinkCount = 0;
  for (const item of hidden) {
    if (item.kind === 'message' && item.role === 'assistant') msgCount += 1;
    else if (item.kind === 'tool') toolCount += 1;
    else if (item.kind === 'thinking') thinkCount += 1;
  }
  const parts: string[] = [];
  if (msgCount > 0) parts.push(`${msgCount} ara mesaj`);
  if (toolCount > 0) parts.push(`${toolCount} araç`);
  if (thinkCount > 0 && parts.length === 0) parts.push(`${thinkCount} düşünme`);
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

  // Split entries into turns starting at each user message
  const turns: TranscriptEntry[][] = [];
  for (const entry of entries) {
    if (isUserEntry(entry) || turns.length === 0) {
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
      if (isUserEntry(entry) || isFoldExemptEntry(entry)) continue;
      foldable.push(entry);
      foldableSet.add(i);
    }

    if (foldable.length === 0) {
      for (const entry of turnEntries) rows.push({ kind: 'entry', entry });
      return;
    }

    const foldId = `mfold:${turnEntries[0]!.id}`;
    const expanded = options.expandedFoldIds.has(foldId);
    let inserted = false;

    for (let i = 0; i < turnEntries.length; i++) {
      const entry = turnEntries[i]!;
      if (foldableSet.has(i)) {
        if (!inserted) {
          rows.push({
            kind: 'turn-fold',
            id: foldId,
            label: formatMobileFoldLabel(foldable),
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
