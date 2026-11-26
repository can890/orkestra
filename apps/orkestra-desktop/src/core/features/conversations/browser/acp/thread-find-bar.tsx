/**
 * ThreadFindBar — In-chat Cmd+F search bar (adapted from T3 Code ThreadFindProvider / useThreadFind).
 * Searches all committed and active turns (including items hidden inside folded turns),
 * temporarily revealing matched items and scrolling smoothly to each match.
 */

import type { TranscriptTurn } from '@orkestra/chat-ui';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

export type ThreadFindMatch = {
  id: string;
  itemId: string;
  turnId: string;
  snippet: string;
};

function extractSearchableText(item: TranscriptTurn['items'][number]): string {
  if (item.kind === 'message') return item.text;
  if (item.kind === 'thinking') return item.text;
  if ('command' in item && typeof item.command === 'string') return item.command;
  if ('inputSummary' in item && typeof item.inputSummary === 'string') return item.inputSummary;
  if ('title' in item && typeof item.title === 'string') return item.title;
  return '';
}

export function findMatchesInTurns(
  turns: readonly TranscriptTurn[],
  query: string
): ThreadFindMatch[] {
  const needle = query.trim().toLocaleLowerCase('tr');
  if (!needle) return [];

  const matches: ThreadFindMatch[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      const text = extractSearchableText(item);
      if (!text) continue;
      const lower = text.toLocaleLowerCase('tr');
      let from = 0;
      let occurrence = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(needle, from);
        if (idx === -1) break;
        const start = Math.max(0, idx - 24);
        const end = Math.min(text.length, idx + needle.length + 36);
        matches.push({
          id: `${item.id}:${occurrence}`,
          itemId: item.id,
          turnId: turn.id,
          snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
        });
        occurrence += 1;
        from = idx + needle.length;
        if (matches.length >= 250) return matches;
      }
    }
  }
  return matches;
}

export function ThreadFindBar({
  open,
  turns,
  onClose,
  onNavigateMatch,
  onRevealItemIds,
}: {
  open: boolean;
  turns: readonly TranscriptTurn[];
  onClose: () => void;
  onNavigateMatch: (itemId: string) => void;
  onRevealItemIds: (ids: ReadonlySet<string>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => (open ? findMatchesInTurns(turns, query) : []), [open, turns, query]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      onRevealItemIds(new Set());
    }
  }, [open, onRevealItemIds]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const activeMatch = matches.length > 0 ? matches[activeIndex % matches.length] : null;

  useEffect(() => {
    if (!open || !activeMatch) {
      onRevealItemIds(new Set());
      return;
    }
    onRevealItemIds(new Set([activeMatch.itemId]));
    const raf = requestAnimationFrame(() => onNavigateMatch(activeMatch.itemId));
    return () => cancelAnimationFrame(raf);
  }, [open, activeMatch, onNavigateMatch, onRevealItemIds]);

  if (!open) return null;

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setActiveIndex((prev) => (prev + delta + matches.length) % matches.length);
  };

  return (
    <div
      data-testid="thread-find-bar"
      className="absolute top-2 right-4 z-30 flex items-center gap-1.5 rounded-lg border border-border bg-(--em-surface) px-2.5 py-1.5 text-xs shadow-lg"
    >
      <Search className="size-3.5 shrink-0 text-foreground-muted" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder="Sohbette ara…"
        className="w-48 bg-transparent text-foreground outline-none placeholder:text-foreground-muted"
      />
      <span className="min-w-[44px] text-right text-[11px] tabular-nums text-foreground-muted">
        {query.trim()
          ? matches.length > 0
            ? `${(activeIndex % matches.length) + 1}/${matches.length}`
            : '0/0'
          : ''}
      </span>
      <button
        type="button"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
        title="Önceki eşleşme (Shift+Enter)"
        aria-label="Önceki eşleşme"
        className="rounded p-0.5 text-foreground-muted hover:bg-foreground/10 hover:text-foreground disabled:opacity-35"
      >
        <ChevronUp className="size-3.5" />
      </button>
      <button
        type="button"
        disabled={matches.length === 0}
        onClick={() => step(1)}
        title="Sonraki eşleşme (Enter)"
        aria-label="Sonraki eşleşme"
        className="rounded p-0.5 text-foreground-muted hover:bg-foreground/10 hover:text-foreground disabled:opacity-35"
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Aramayı kapat (Esc)"
        aria-label="Aramayı kapat"
        className="rounded p-0.5 text-foreground-muted hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
