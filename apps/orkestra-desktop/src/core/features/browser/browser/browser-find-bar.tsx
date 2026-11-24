// Adapted from pingdotgg/t3code (MIT) — inline find bar for embedded browser.
import { Button } from '@orkestra/ui/react/primitives';
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { browserPointerStore } from '@core/features/browser/api/browser/browser-pointer-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { cn } from '@core/primitives/styling/browser/cn';

export const BrowserFindBar = observer(function BrowserFindBar({
  browserId,
  onClose,
}: {
  browserId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const findResult = browserPointerStore.getFindResult(browserId);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      browserPointerStore.clearFindResult(browserId);
      void getBrowserClient()
        .then((c) => c.stopFindInPage({ browserId, action: 'clearSelection' }))
        .catch(() => {});
    };
  }, [browserId]);

  const runFind = (text: string, forward: boolean, findNext: boolean) => {
    void getBrowserClient()
      .then((c) =>
        c.findInPage({
          browserId,
          text,
          forward,
          matchCase,
          findNext,
        })
      )
      .catch(() => {});
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background-secondary/80 px-2.5 text-xs">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Sayfada bul..."
        aria-label="Sayfada bul"
        className="h-6 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus:border-ring"
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          runFind(next, true, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (query.trim()) runFind(query, !e.shiftKey, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      {query.trim() ? (
        <span className="min-w-10 text-center text-[11px] text-foreground-muted tabular-nums">
          {findResult && findResult.matches > 0
            ? `${findResult.activeMatchOrdinal}/${findResult.matches}`
            : '0/0'}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon
        className={cn('size-6', matchCase && 'bg-accent text-foreground')}
        aria-label="Büyük/küçük harf duyarlı"
        onClick={() => {
          const next = !matchCase;
          setMatchCase(next);
          if (query.trim()) {
            void getBrowserClient()
              .then((c) =>
                c.findInPage({
                  browserId,
                  text: query,
                  forward: true,
                  matchCase: next,
                  findNext: false,
                })
              )
              .catch(() => {});
          }
        }}
      >
        <CaseSensitive className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon
        className="size-6"
        aria-label="Önceki eşleşme"
        disabled={!query.trim()}
        onClick={() => runFind(query, false, true)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon
        className="size-6"
        aria-label="Sonraki eşleşme"
        disabled={!query.trim()}
        onClick={() => runFind(query, true, true)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon
        className="size-6"
        aria-label="Bul çubuğunu kapat"
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
});
