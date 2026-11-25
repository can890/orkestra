import { Markdown } from '@orkestra/ui/react/components';
import { Badge } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';

const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024;

export type NotebookCell = {
  cell_type: 'markdown' | 'code' | 'raw' | string;
  execution_count?: number | null;
  source?: string | string[];
  outputs?: NotebookOutput[];
};

export type NotebookOutput = {
  output_type?: string;
  text?: string | string[];
  ename?: string;
  evalue?: string;
  traceback?: string[];
  data?: Record<string, string | string[]>;
};

export type ParsedNotebook =
  | { kind: 'ready'; kernelName?: string; language?: string; cells: NotebookCell[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

function joinLines(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('');
  return '';
}

export function parseNotebookJson(raw: string): ParsedNotebook {
  if (raw.length > MAX_NOTEBOOK_BYTES) {
    return {
      kind: 'error',
      message: 'Notebook önizlemesi 8 MB altındaki dosyalarla sınırlıdır.',
    };
  }
  if (!raw.trim()) return { kind: 'empty' };
  try {
    const parsed = JSON.parse(raw) as {
      cells?: unknown;
      metadata?: {
        kernelspec?: { display_name?: string; language?: string };
        language_info?: { name?: string };
      };
    };
    if (!parsed || !Array.isArray(parsed.cells)) {
      return { kind: 'error', message: 'Geçerli bir Jupyter Notebook (cells dizisi) bulunamadı.' };
    }
    if (parsed.cells.length === 0) return { kind: 'empty' };
    return {
      kind: 'ready',
      kernelName: parsed.metadata?.kernelspec?.display_name,
      language:
        parsed.metadata?.language_info?.name ?? parsed.metadata?.kernelspec?.language ?? 'python',
      cells: parsed.cells as NotebookCell[],
    };
  } catch (error) {
    return {
      kind: 'error',
      message:
        error instanceof Error
          ? `Notebook JSON ayrıştırılamadı: ${error.message}`
          : 'Notebook ayrıştırılamadı.',
    };
  }
}

export const NotebookRenderer = observer(function NotebookRenderer({
  tab,
}: {
  tab: FileTabResource;
}) {
  void tab.bufferVersion;
  const content = tab.bufferText();
  const parsed = useMemo(() => parseNotebookJson(content), [content]);

  if (parsed.kind === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-(--em-surface) p-6 text-xs text-foreground-muted">
        {parsed.message}
      </div>
    );
  }

  if (parsed.kind === 'empty') {
    return (
      <div className="flex h-full items-center justify-center bg-(--em-surface) p-6 text-xs text-foreground-muted">
        Bu notebook boş.
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-(--em-surface)">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-foreground-muted">
        <span>Jupyter Notebook · {parsed.cells.length} hücre</span>
        <div className="flex items-center gap-1.5">
          {parsed.kernelName && <Badge variant="soft">{parsed.kernelName}</Badge>}
          {parsed.language && <Badge variant="outline">{parsed.language}</Badge>}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {parsed.cells.map((cell, idx) => {
          const source = joinLines(cell.source);
          if (cell.cell_type === 'markdown') {
            return (
              <div
                key={idx}
                className="rounded-lg border border-border/60 bg-background-1 px-4 py-3"
              >
                <Markdown content={source} variant="full" />
              </div>
            );
          }

          return (
            <div
              key={idx}
              className="overflow-hidden rounded-lg border border-border bg-background-1"
            >
              <div className="flex items-center justify-between border-b border-border/70 bg-background-2 px-3 py-1 font-mono text-[11px] text-foreground-muted">
                <span>
                  {cell.cell_type === 'code'
                    ? `In [${cell.execution_count ?? ' '}]`
                    : cell.cell_type.toUpperCase()}
                </span>
                <span>{parsed.language ?? 'text'}</span>
              </div>
              <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground">
                <code>{source}</code>
              </pre>
              {Array.isArray(cell.outputs) && cell.outputs.length > 0 && (
                <div className="space-y-2 border-t border-border/70 bg-(--em-surface) p-3 text-xs">
                  {cell.outputs.map((out, outIdx) => {
                    if (out.output_type === 'error') {
                      return (
                        <pre
                          key={outIdx}
                          className="bg-destructive/10 text-destructive overflow-x-auto rounded p-2 font-mono text-[11px]"
                        >
                          {`${out.ename ?? 'Error'}: ${out.evalue ?? ''}`}
                        </pre>
                      );
                    }
                    const png = out.data?.['image/png'];
                    const jpeg = out.data?.['image/jpeg'];
                    const imgB64 = png ? joinLines(png) : jpeg ? joinLines(jpeg) : '';
                    const imgMime = png ? 'image/png' : 'image/jpeg';
                    const text = joinLines(out.text) || joinLines(out.data?.['text/plain']) || '';

                    return (
                      <div key={outIdx} className="space-y-1.5">
                        {imgB64 && (
                          <img
                            src={`data:${imgMime};base64,${imgB64.trim()}`}
                            alt="Notebook çıktısı"
                            className="max-h-96 rounded border border-border bg-white object-contain"
                          />
                        )}
                        {text && (
                          <pre className="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-foreground-muted">
                            {text}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
