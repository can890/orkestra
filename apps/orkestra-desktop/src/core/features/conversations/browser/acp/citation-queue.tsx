/**
 * Multi-Citation Comment Queue (Feature #8 — adapted from T3 Code AssistantCitationCommentEditor).
 * Lets the user queue multiple quoted excerpts with per-citation inline notes and insert them
 * together into the composer prompt.
 */

import { Button } from '@orkestra/ui/react/primitives';
import { MessageSquareQuote, Send, Trash2, X } from 'lucide-react';

export type QueuedCitation = {
  id: string;
  excerpt: string;
  comment: string;
};

export function formatCitationsMarkdown(citations: readonly QueuedCitation[]): string {
  return citations
    .map((c, idx) => {
      const quoted = c.excerpt
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const note = c.comment.trim();
      const header = citations.length > 1 ? `**Alıntı ${idx + 1}:**\n` : '';
      return note ? `${header}${quoted}\n\nNot: ${note}` : `${header}${quoted}`;
    })
    .join('\n\n---\n\n');
}

export function CitationQueueTray({
  citations,
  onUpdateComment,
  onRemove,
  onClear,
  onApplyAll,
}: {
  citations: readonly QueuedCitation[];
  onUpdateComment: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onApplyAll: () => void;
}) {
  if (citations.length === 0) return null;

  return (
    <div
      data-testid="citation-queue-tray"
      className="pointer-events-auto mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5 rounded-xl border border-border bg-(--em-surface) p-2.5 text-xs shadow-md"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <MessageSquareQuote className="size-3.5 text-foreground-muted" />
          Alıntı yorumları ({citations.length})
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="ghost" onClick={onClear}>
            <Trash2 className="size-3" />
            Temizle
          </Button>
          <Button size="xs" variant="secondary" onClick={onApplyAll}>
            <Send className="size-3" />
            Mesaja ekle
          </Button>
        </div>
      </div>
      <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
        {citations.map((item) => (
          <div
            key={item.id}
            className="flex flex-col gap-1 rounded-lg border border-border/70 bg-foreground/[0.03] p-2"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="line-clamp-2 flex-1 border-l-2 border-foreground/30 pl-2 text-[11px] text-foreground-muted">
                {item.excerpt}
              </p>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label="Alıntıyı kaldır"
                className="rounded p-0.5 text-foreground-muted hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
            <input
              type="text"
              value={item.comment}
              onChange={(e) => onUpdateComment(item.id, e.target.value)}
              placeholder="Bu alıntı için notunuzu yazın…"
              className="w-full rounded border border-border/60 bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-foreground/40"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
