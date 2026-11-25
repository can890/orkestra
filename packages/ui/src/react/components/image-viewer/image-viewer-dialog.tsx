import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, Download, XIcon } from 'lucide-react';
import * as React from 'react';
import * as styles from './image-viewer.css';

export interface MediaViewerItem {
  src: string;
  alt?: string;
  kind?: 'image' | 'video';
  downloadName?: string;
  /**
   * Host-handled download (e.g. a streamed media URL that cannot be saved with `<a download>`).
   * When set, the download control calls it instead of linking to `src`.
   */
  onDownload?: () => void;
}

export interface ImageViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Data/media URL to display when `items` is omitted. */
  src?: string;
  /** Accessible name for the image/video and dialog. */
  alt?: string;
  kind?: 'image' | 'video';
  /** Multi-item gallery; when provided, overrides single `src`/`alt`. */
  items?: MediaViewerItem[];
  initialIndex?: number;
}

/**
 * Claude-style compact, content-fitted lightbox dialog for images and videos.
 * Clicking anywhere outside the media frame (or pressing Escape) closes it immediately.
 */
export function ImageViewerDialog({
  open,
  onOpenChange,
  src,
  alt,
  kind = 'image',
  items,
  initialIndex = 0,
}: ImageViewerDialogProps) {
  const gallery = React.useMemo<MediaViewerItem[]>(() => {
    if (items && items.length > 0) return items;
    if (src) return [{ src, alt, kind, downloadName: alt }];
    return [];
  }, [items, src, alt, kind]);

  const [index, setIndex] = React.useState(initialIndex);

  React.useEffect(() => {
    if (!open) return;
    const clamped = Math.max(0, Math.min(initialIndex, Math.max(0, gallery.length - 1)));
    setIndex(clamped);
  }, [open, initialIndex, gallery.length]);

  React.useEffect(() => {
    if (!open || gallery.length <= 1) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((prev) => (prev - 1 + gallery.length) % gallery.length);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex((prev) => (prev + 1) % gallery.length);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, gallery.length]);

  const current = gallery[index];
  const currentAlt = current?.alt ?? alt ?? (current?.kind === 'video' ? 'Video' : 'Görsel');

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className={styles.lightboxBackdrop} />
        <div
          className={styles.lightboxPositioner}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onOpenChange(false);
            }
          }}
        >
          <DialogPrimitive.Popup
            aria-label={currentAlt}
            className={styles.lightboxCard}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.lightboxControls}>
              {current?.onDownload ? (
                <button
                  type="button"
                  className={styles.lightboxIconBtn}
                  aria-label="İndir"
                  title="İndir"
                  onClick={current.onDownload}
                >
                  <Download style={{ width: '0.875rem', height: '0.875rem' }} />
                </button>
              ) : (
                current?.src && (
                  <a
                    href={current.src}
                    download={current.downloadName ?? currentAlt}
                    className={styles.lightboxIconBtn}
                    aria-label="İndir"
                    title="İndir"
                  >
                    <Download style={{ width: '0.875rem', height: '0.875rem' }} />
                  </a>
                )
              )}
              <button
                type="button"
                className={styles.lightboxIconBtn}
                aria-label="Kapat"
                title="Kapat"
                onClick={() => onOpenChange(false)}
              >
                <XIcon style={{ width: '0.875rem', height: '0.875rem' }} />
              </button>
            </div>

            {gallery.length > 1 && (
              <>
                <button
                  type="button"
                  className={`${styles.lightboxNavBtn} ${styles.lightboxNavPrev}`}
                  aria-label="Önceki"
                  onClick={() => setIndex((prev) => (prev - 1 + gallery.length) % gallery.length)}
                >
                  <ChevronLeft style={{ width: '1rem', height: '1rem' }} />
                </button>
                <button
                  type="button"
                  className={`${styles.lightboxNavBtn} ${styles.lightboxNavNext}`}
                  aria-label="Sonraki"
                  onClick={() => setIndex((prev) => (prev + 1) % gallery.length)}
                >
                  <ChevronRight style={{ width: '1rem', height: '1rem' }} />
                </button>
                <div className={styles.lightboxCounter}>
                  {index + 1} / {gallery.length}
                </div>
              </>
            )}

            {!current?.src ? (
              <div className={styles.lightboxUnavailable}>İçerik görüntülenemiyor.</div>
            ) : current.kind === 'video' ? (
              <video
                key={current.src}
                src={current.src}
                controls
                autoPlay
                playsInline
                className={styles.lightboxMedia}
              />
            ) : (
              <img
                key={current.src}
                src={current.src}
                alt={currentAlt}
                draggable={false}
                className={styles.lightboxMedia}
              />
            )}
          </DialogPrimitive.Popup>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
