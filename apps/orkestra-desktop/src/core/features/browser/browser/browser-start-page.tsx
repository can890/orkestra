import { Clock, Globe, Server, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { browserHistoryStore } from '@core/features/browser/api/browser/browser-history-store';

export const BrowserStartPage = observer(function BrowserStartPage({
  devServerUrls,
  onOpenUrl,
}: {
  devServerUrls: string[];
  onOpenUrl: (url: string) => void;
}) {
  const localUrls = devServerUrls.filter(isLocalUrl);
  const recentEntries = browserHistoryStore.entries;

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      <div className="flex w-full max-w-xl flex-col gap-5">
        {localUrls.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
                Yerel sunucular
              </h2>
              <Server className="size-3.5 text-foreground-tertiary-muted" />
            </div>
            <div className="flex flex-col gap-2">
              {localUrls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="group focus-visible:ring-ring/50 flex min-h-14 w-full items-center gap-3 rounded-lg border border-border bg-background-secondary/40 px-3.5 py-2.5 text-left transition-colors hover:bg-background-secondary focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() => onOpenUrl(url)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-info">
                    <Globe className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {formatServerTitle(url)}
                    </span>
                    <span className="block truncate text-xs text-foreground-muted">
                      {formatServerAddress(url)}
                    </span>
                  </span>
                  <span className="size-2 shrink-0 rounded-full bg-foreground-info" />
                </button>
              ))}
            </div>
          </section>
        )}

        {recentEntries.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-foreground-muted uppercase">
                <Clock className="size-3.5" />
                <span>Son ziyaret edilenler</span>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-foreground-muted hover:text-foreground"
                onClick={() => browserHistoryStore.clear()}
              >
                <Trash2 className="size-3" />
                Temizle
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {recentEntries.map((entry) => (
                <button
                  key={entry.url}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border/60 bg-background px-3 py-2 text-left transition-colors hover:bg-background-secondary/70"
                  onClick={() => onOpenUrl(entry.url)}
                >
                  <Globe className="size-3.5 shrink-0 text-foreground-muted" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {entry.title}
                  </span>
                  <span className="max-w-44 truncate text-[11px] text-foreground-muted">
                    {formatServerAddress(entry.url)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {localUrls.length === 0 && recentEntries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-foreground-muted">
            <Globe className="size-7 opacity-40" />
            <p className="text-sm font-medium text-foreground">Önizleme hazır</p>
            <p className="max-w-xs text-xs">
              Yukarıdaki adres çubuğuna bir URL yazın veya bir yerelleştirme sunucusunu açın.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function formatServerAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

function formatServerTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `Yerel sunucu :${parsed.port}` : parsed.hostname;
  } catch {
    return 'Yerel sunucu';
  }
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
