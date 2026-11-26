/**
 * TimelineMinimap — Slim right-edge vertical tick strip of conversation turns
 * (adapted from T3 Code TimelineMinimap.tsx). Hover previews each prompt; clicking jumps to it.
 */

import type { TranscriptTurn } from '@orkestra/chat-ui';
import { useMemo, useState } from 'react';

type MinimapTurnTick = {
  turnId: string;
  itemId: string;
  preview: string;
  hasError: boolean;
};

export function TimelineMinimap({
  turns,
  onSelectItem,
}: {
  turns: readonly TranscriptTurn[];
  onSelectItem: (itemId: string) => void;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const ticks = useMemo<MinimapTurnTick[]>(() => {
    const out: MinimapTurnTick[] = [];
    for (const turn of turns) {
      const userMsg = turn.items.find((it) => it.kind === 'message' && it.role === 'user');
      if (!userMsg || userMsg.kind !== 'message') continue;
      const firstLine = userMsg.text.trim().split(/\r?\n/, 1)[0] ?? '';
      out.push({
        turnId: turn.id,
        itemId: userMsg.id,
        preview: firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine || 'İstek',
        hasError: turn.outcome?.kind === 'error',
      });
    }
    return out;
  }, [turns]);

  if (ticks.length < 3) return null;

  return (
    <div
      data-testid="timeline-minimap"
      aria-label="Sohbet tur haritası"
      className="pointer-events-auto absolute top-14 right-1.5 bottom-28 z-20 flex w-4 flex-col items-end justify-center gap-1.5 py-2 opacity-60 transition-opacity hover:opacity-100"
      onMouseLeave={() => setHoveredIdx(null)}
    >
      {ticks.map((tick, idx) => {
        const hovered = hoveredIdx === idx;
        return (
          <div key={tick.turnId} className="relative flex items-center">
            {hovered && (
              <div className="pointer-events-none absolute right-5 z-30 max-w-60 truncate rounded-md border border-border bg-(--em-surface) px-2 py-1 text-[11px] text-foreground shadow-md">
                <span className="mr-1 text-foreground-muted">#{idx + 1}</span>
                {tick.preview}
              </div>
            )}
            <button
              type="button"
              onMouseEnter={() => setHoveredIdx(idx)}
              onClick={() => onSelectItem(tick.itemId)}
              aria-label={`Tur ${idx + 1}: ${tick.preview}`}
              className={`h-1.5 rounded-full transition-all ${
                tick.hasError
                  ? 'bg-red-400/80'
                  : hovered
                    ? 'w-3.5 bg-foreground'
                    : 'w-2 bg-foreground-muted/50 hover:w-3 hover:bg-foreground/80'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}
