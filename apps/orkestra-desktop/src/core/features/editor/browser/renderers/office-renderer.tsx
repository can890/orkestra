import { Badge, Button, Input, Spinner } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { readBinaryFile } from '@core/features/files/api/browser/file-content';
import {
  MAX_OFFICE_ARCHIVE_BYTES,
  parseOfficeDocument,
  type OfficePreviewDocument,
} from './office-preview-parser';

export const OfficeRenderer = observer(function OfficeRenderer({ tab }: { tab: FileTabResource }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; doc: OfficePreviewDocument }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const ref = tab.ref;

  useEffect(() => {
    setActiveSheetIdx(0);
    setSearchQuery('');
    if (!ref) {
      setState({ kind: 'error', message: 'Office dosyası referansı bulunamadı.' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });

    void readBinaryFile(ref)
      .then(async (result) => {
        if (cancelled) return;
        if (!result.success) {
          setState({ kind: 'error', message: 'Office dosyası okunamadı.' });
          return;
        }
        if (result.data.truncated || result.data.size > MAX_OFFICE_ARCHIVE_BYTES) {
          setState({
            kind: 'error',
            message: 'Office önizlemeleri 25 MB ile sınırlıdır.',
          });
          return;
        }
        const doc = await parseOfficeDocument(tab.path, result.data.bytes);
        if (!cancelled) setState({ kind: 'ready', doc });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Office dosyası önizlenemedi.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ref, tab.path]);

  const filteredSheetRows = useMemo(() => {
    if (state.kind !== 'ready' || state.doc.kind !== 'xlsx') return [];
    const sheet = state.doc.sheets[activeSheetIdx];
    if (!sheet) return [];
    const q = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!q) return sheet.rows;
    return sheet.rows.filter((row) =>
      row.some((cell) => cell.toLocaleLowerCase('tr-TR').includes(q))
    );
  }, [state, activeSheetIdx, searchQuery]);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-(--em-surface)">
        <Spinner size="sm" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-(--em-surface) p-6 text-xs text-foreground-muted">
        {state.message}
      </div>
    );
  }

  const { doc } = state;

  if (doc.kind === 'docx') {
    return (
      <div className="flex h-full w-full flex-col bg-(--em-surface)">
        <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-foreground-muted">
          <span>Word Belgesi (.docx)</span>
          <span>
            {doc.paragraphs.length} paragraf · {doc.tables.length} tablo
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-3xl space-y-3 rounded-lg border border-border bg-background-1 p-6 text-sm leading-relaxed text-foreground">
            {doc.paragraphs.length === 0 && doc.tables.length === 0 && (
              <p className="text-xs text-foreground-muted">Belge metni bulunamadı.</p>
            )}
            {doc.paragraphs.map((p, idx) => (
              <p key={idx}>{p}</p>
            ))}
            {doc.tables.map((table, tIdx) => (
              <div key={tIdx} className="overflow-x-auto pt-2">
                <table className="min-w-full border-collapse text-left text-xs">
                  <tbody>
                    {table.map((row, rIdx) => (
                      <tr key={rIdx} className="border-b border-border/70">
                        {row.map((cell, cIdx) => (
                          <td key={cIdx} className="border border-border/60 px-2.5 py-1.5">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (doc.kind === 'xlsx') {
    const activeSheet = doc.sheets[activeSheetIdx] ?? doc.sheets[0];
    return (
      <div className="flex h-full w-full flex-col bg-(--em-surface)">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1">
            {doc.sheets.map((sheet, idx) => (
              <Button
                key={sheet.name}
                type="button"
                size="sm"
                variant={idx === activeSheetIdx ? 'secondary' : 'ghost'}
                onClick={() => setActiveSheetIdx(idx)}
                className="h-6 px-2 text-xs"
              >
                {sheet.name}
              </Button>
            ))}
          </div>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Satırlarda ara…"
            className="h-7 w-48 text-xs"
          />
        </div>
        {activeSheet?.truncatedRows && (
          <div className="border-b border-border bg-background-2 px-3 py-1 text-[11px] text-foreground-muted">
            İlk {activeSheet.rows.length} satır gösteriliyor.
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
            <tbody>
              {filteredSheetRows.map((row, rIdx) => (
                <tr key={rIdx} className={rIdx === 0 ? 'bg-background-2 font-medium' : ''}>
                  <td className="border-r border-b border-border px-2 py-1 text-[11px] text-foreground-muted tabular-nums">
                    {rIdx + 1}
                  </td>
                  {row.map((cell, cIdx) => (
                    <td
                      key={cIdx}
                      className="max-w-72 truncate border-r border-b border-border px-2.5 py-1.5 text-foreground"
                      title={cell}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-(--em-surface)">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-foreground-muted">
        <span>PowerPoint Sunumu (.pptx)</span>
        <span>{doc.slides.length} slayt</span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {doc.slides.map((slide) => (
          <div
            key={slide.index}
            className="mx-auto max-w-3xl space-y-2 rounded-lg border border-border bg-background-1 p-5"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{slide.title}</h3>
              <Badge variant="outline">Slayt {slide.index}</Badge>
            </div>
            {slide.texts.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-foreground-muted">
                {slide.texts.map((line, idx) => (
                  <li key={idx}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
