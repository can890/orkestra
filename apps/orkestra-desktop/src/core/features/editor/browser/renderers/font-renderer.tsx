import { Input, Spinner } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useState } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { readBinaryFile } from '@core/features/files/api/browser/file-content';

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const DEFAULT_SAMPLE =
  'Pijamalı hasta yağız şoföre çabucak güvendi. ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ 0123456789';
const GLYPH_STRIP =
  'A B C Ç D E F G Ğ H I İ J K L M N O Ö P R S Ş T U Ü V Y Z\na b c ç d e f g ğ h ı i j k l m n o ö p r s ş t u ü v y z\n0 1 2 3 4 5 6 7 8 9 ! ? @ # $ % & * ( ) [ ] { } < > / \\';

export const FontRenderer = observer(function FontRenderer({ tab }: { tab: FileTabResource }) {
  const familyId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const familyName = `OrkestraPreviewFont_${familyId}`;
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [fontSize, setFontSize] = useState(28);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; sizeBytes: number }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const ref = tab.ref;

  useEffect(() => {
    if (!ref) {
      setState({ kind: 'error', message: 'Yazı tipi dosyası bulunamadı.' });
      return;
    }
    let cancelled = false;
    let loadedFace: FontFace | null = null;
    setState({ kind: 'loading' });

    void readBinaryFile(ref)
      .then(async (result) => {
        if (cancelled) return;
        if (!result.success) {
          setState({ kind: 'error', message: 'Yazı tipi dosyası okunamadı.' });
          return;
        }
        if (result.data.truncated || result.data.size > MAX_FONT_BYTES) {
          setState({
            kind: 'error',
            message: 'Yazı tipi önizlemeleri 10 MB ile sınırlıdır.',
          });
          return;
        }
        const face = new FontFace(familyName, result.data.bytes);
        await face.load();
        if (cancelled) return;
        document.fonts.add(face);
        loadedFace = face;
        setState({ kind: 'ready', sizeBytes: result.data.size });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Yazı tipi yüklenemedi.',
          });
        }
      });

    return () => {
      cancelled = true;
      if (loadedFace) {
        document.fonts.delete(loadedFace);
      }
    };
  }, [ref, familyName]);

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

  return (
    <div className="flex h-full w-full flex-col bg-(--em-surface)">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs">
        <span className="text-foreground-muted">
          Yazı Tipi Önizleme ({(state.sizeBytes / 1024).toFixed(1)} KB)
        </span>
        <div className="flex items-center gap-2">
          <span className="text-foreground-muted">Punto: {fontSize}px</span>
          <input
            type="range"
            min={12}
            max={72}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            aria-label="Yazı tipi boyutu"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="space-y-2">
          <Input
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Önizlemek için metin yazın…"
            aria-label="Örnek metin"
          />
          <div
            className="rounded-lg border border-border bg-background-1 p-5 leading-snug break-words text-foreground"
            style={{ fontFamily: `"${familyName}", sans-serif`, fontSize: `${fontSize}px` }}
          >
            {sample || DEFAULT_SAMPLE}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground-muted">Boyut Karşılaştırması</div>
          <div className="space-y-2 rounded-lg border border-border bg-background-1 p-4">
            {[14, 18, 24, 36].map((size) => (
              <div key={size} className="flex items-baseline gap-3">
                <span className="w-10 shrink-0 font-mono text-[11px] text-foreground-muted">
                  {size}px
                </span>
                <span
                  className="truncate text-foreground"
                  style={{ fontFamily: `"${familyName}", sans-serif`, fontSize: `${size}px` }}
                >
                  {sample || DEFAULT_SAMPLE}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground-muted">Karakter Tablosu</div>
          <pre
            className="rounded-lg border border-border bg-background-1 p-4 text-lg leading-relaxed whitespace-pre-wrap text-foreground"
            style={{ fontFamily: `"${familyName}", sans-serif` }}
          >
            {GLYPH_STRIP}
          </pre>
        </div>
      </div>
    </div>
  );
});
