import { Button, Spinner } from '@orkestra/ui/react/primitives';
import { ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { readBinaryFile } from '@core/features/files/api/browser/file-content';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';

const MAX_PDF_BYTES = 50 * 1024 * 1024;

export const PdfRenderer = observer(function PdfRenderer({ tab }: { tab: FileTabResource }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; blobUrl: string; sizeBytes: number }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const ref = tab.ref;

  useEffect(() => {
    if (!ref) {
      setState({ kind: 'error', message: 'Dosya referansı bulunamadı.' });
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setState({ kind: 'loading' });

    void readBinaryFile(ref)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setState({ kind: 'error', message: 'PDF dosyası okunamadı.' });
          return;
        }
        if (result.data.truncated || result.data.size > MAX_PDF_BYTES) {
          setState({
            kind: 'error',
            message: 'PDF önizlemesi 50 MB boyut sınırı nedeniyle gösterilemiyor.',
          });
          return;
        }
        const blob = new Blob([result.data.bytes], { type: 'application/pdf' });
        createdUrl = URL.createObjectURL(blob);
        setState({ kind: 'ready', blobUrl: createdUrl, sizeBytes: result.data.size });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'PDF yüklenemedi.',
          });
        }
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [ref]);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-(--em-surface)">
        <Spinner size="sm" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-(--em-surface) p-6 text-center text-xs text-foreground-muted">
        <span>{state.message}</span>
        {ref && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void getHostClient().then((c) => c.openPath({ ref }))}
            className="gap-1.5"
          >
            <ExternalLink className="size-3.5" />
            Dışarıda Aç
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-(--em-surface)">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-foreground-muted">
        <span>PDF Önizleme ({(state.sizeBytes / 1024).toFixed(1)} KB)</span>
        {ref && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void getHostClient().then((c) => c.openPath({ ref }))}
            className="h-6 gap-1 px-2 text-xs"
          >
            <ExternalLink className="size-3" />
            Varsayılan Uygulamada Aç
          </Button>
        )}
      </div>
      <iframe
        title={tab.path}
        src={state.blobUrl}
        className="min-h-0 w-full flex-1 border-0 bg-background-1"
      />
    </div>
  );
});
