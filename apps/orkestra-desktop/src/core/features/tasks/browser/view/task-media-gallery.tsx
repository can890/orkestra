import type { ToolNode, TranscriptTurn } from '@orkestra/chat-ui';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Images,
  Loader2,
  Maximize2,
  Music,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  createTranscriptArtifactMediaUrl,
  createTranscriptArtifactResolver,
  createTranscriptArtifactSaver,
} from '@core/features/conversations/api/browser/chat/transcript-artifact-commands';
import { cn } from '@core/primitives/styling/browser/cn';

export type TaskMediaKind = 'image' | 'video' | 'audio' | 'pdf';

export interface TaskMediaItem {
  id: string;
  uri: string;
  name: string;
  folderHint?: string;
  kind: TaskMediaKind;
  mimeType?: string;
  artifact: TranscriptArtifact;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac']);
const PDF_EXTS = new Set(['pdf']);

// Yalnızca gerçek mutlak dosya yollarını (veya file:// URL'lerini) yakala — kabuk parçacıklarını değil.
const ABSOLUTE_MEDIA_PATH_RE =
  /(?:file:\/\/)?(\/[A-Za-z0-9._@+\-/]+\.(?:png|jpe?g|webp|gif|avif|mp4|m4v|webm|mov|mp3|wav|m4a|ogg|aac|flac|pdf))\b/gi;

// Çözülen medya URL'lerini oturum boyunca önbellekte tut (yeniden çizimde ses/video kesilmesin).
type CachedMediaEntry =
  | { status: 'ok'; url: string }
  | { status: 'error' }
  | { status: 'pending'; promise: Promise<string | null> };

const mediaUrlCache = new Map<string, CachedMediaEntry>();

function mediaCacheKey(projectId: string, taskId: string, uri: string): string {
  return `${projectId}::${taskId}::${uri}`;
}

function resolveMediaCached(
  item: TaskMediaItem,
  projectId: string,
  taskId: string
): Promise<string | null> {
  if (item.uri.startsWith('data:') || /^https?:\/\//i.test(item.uri)) {
    return Promise.resolve(item.uri);
  }
  const key = mediaCacheKey(projectId, taskId, item.uri);
  const existing = mediaUrlCache.get(key);
  if (existing?.status === 'ok') return Promise.resolve(existing.url);
  if (existing?.status === 'error') return Promise.resolve(null);
  if (existing?.status === 'pending') return existing.promise;

  const promise = (async (): Promise<string | null> => {
    try {
      if (item.kind === 'video' || item.kind === 'audio' || item.kind === 'pdf') {
        const mediaUrl = createTranscriptArtifactMediaUrl({ projectId, taskId });
        const res = await mediaUrl(item.artifact);
        mediaUrlCache.set(key, { status: 'ok', url: res.url });
        return res.url;
      }
      const resolve = createTranscriptArtifactResolver({ projectId, taskId });
      const res = await resolve(item.artifact);
      mediaUrlCache.set(key, { status: 'ok', url: res.url });
      return res.url;
    } catch {
      mediaUrlCache.set(key, { status: 'error' });
      return null;
    }
  })();

  mediaUrlCache.set(key, { status: 'pending', promise });
  return promise;
}

function detectKind(uri: string, mimeType?: string): TaskMediaKind | null {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';

  if (uri.startsWith('data:image/')) return 'image';
  if (uri.startsWith('data:video/')) return 'video';
  if (uri.startsWith('data:audio/')) return 'audio';
  if (uri.startsWith('data:application/pdf')) return 'pdf';

  const clean = uri.split(/[?#]/)[0] ?? '';
  const ext = clean.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
}

function fileBasename(uri: string, fallback?: string): string {
  if (fallback && fallback.trim()) return fallback.trim();
  if (uri.startsWith('data:')) {
    const ext = uri.match(/^data:[^/]+\/([a-z0-9+.-]+);/i)?.[1] ?? 'png';
    return `gorsel.${ext.replace('+xml', '')}`;
  }
  const clean = uri.replace(/^file:\/\//i, '').split(/[?#]/)[0] ?? uri;
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? clean;
}

function folderHintOf(uri: string): string | undefined {
  if (uri.startsWith('data:')) return undefined;
  const clean = uri.replace(/^file:\/\//i, '').split(/[?#]/)[0] ?? '';
  const parts = clean.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts[parts.length - 2];
}

function normalizeDedupKey(uri: string): string {
  if (uri.startsWith('data:')) {
    return `data:${uri.length}:${uri.slice(0, 80)}:${uri.slice(-32)}`;
  }
  return uri.replace(/^file:\/\//i, '').replace(/^sandbox:/i, '').trim();
}

function extractPathsFromText(text: string | undefined): string[] {
  if (!text) return [];
  const results: string[] = [];
  ABSOLUTE_MEDIA_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ABSOLUTE_MEDIA_PATH_RE.exec(text)) !== null) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (candidate.length > 260) continue;
    if (
      candidate.includes('/node_modules/') ||
      candidate.includes('/.git/') ||
      candidate.includes('/.claude/') ||
      candidate.includes('/tool-results/')
    ) {
      continue;
    }
    results.push(candidate);
  }
  return results;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Görevdeki tüm konuşma turlarından (mesajlar, araç çıktıları ve alt ajanlar)
 * üretilen veya işlenen görsel, video, ses ve PDF dosyalarını kararlı kimliklerle toplar.
 */
export function collectTaskMedia(turnGroups: readonly (readonly TranscriptTurn[])[]): TaskMediaItem[] {
  const seen = new Set<string>();
  const collected: TaskMediaItem[] = [];

  const pushArtifact = (artifact: TranscriptArtifact) => {
    const uri = artifact.uri?.trim();
    if (!uri) return;
    const kind = detectKind(uri, artifact.mimeType);
    if (!kind) return;
    const key = normalizeDedupKey(uri);
    if (seen.has(key)) return;
    seen.add(key);
    collected.push({
      // Kararlı kimlik (dizi sırasına bağlı değil!) — yeni öğe geldiğinde mevcut oynatıcılar sıfırlanmaz.
      id: key,
      uri,
      name: fileBasename(uri, artifact.name),
      folderHint: folderHintOf(uri),
      kind,
      mimeType: artifact.mimeType,
      artifact: { ...artifact, uri },
    });
  };

  const pushPaths = (text?: string) => {
    for (const p of extractPathsFromText(text)) {
      pushArtifact({ uri: p, name: fileBasename(p) });
    }
  };

  const walkTools = (nodes: readonly ToolNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'tool-group' && node.artifacts?.length) {
        for (const art of node.artifacts) pushArtifact(art);
      }
      if (node.kind === 'execute-tool-call') {
        // Yalnızca komut çıktısındaki gerçek dosya yolları (komut satırındaki geçici/silinen argümanlar değil)
        pushPaths(node.outputText);
      } else if (node.kind === 'create-file-tool-call' || node.kind === 'modify-file-tool-call') {
        pushPaths(node.path);
      } else if (node.kind === 'read-tool-call') {
        for (const loc of node.locations ?? []) pushPaths(loc.path);
      } else if (node.kind === 'spawn-subagent-tool-call') {
        pushPaths(node.outputText);
      }
      if ('children' in node && node.children?.length) {
        walkTools(node.children);
      }
    }
  };

  for (const turns of turnGroups) {
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.kind === 'message') {
          for (const art of item.artifacts ?? []) pushArtifact(art);
          if (item.role === 'assistant') {
            pushPaths(item.text);
          }
        } else if (item.kind !== 'thinking') {
          walkTools([item]);
        }
      }
    }
  }

  return collected.reverse();
}

/** Öğe ekrana girince tek seferde görünür kabul eder (194 öğeyi aynı anda SSH'tan çekmez). */
function useVisibleOnce(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return [ref, visible];
}

/** Önbellekli medya URL kancası — üst bileşen yeniden çizilse bile asla sıfırlanmaz. */
function useCachedMediaUrl(
  item: TaskMediaItem | null,
  projectId: string,
  taskId: string,
  enabled: boolean
): { url: string | null; loading: boolean; error: boolean } {
  const getImmediate = () => {
    if (!item) return { url: null as string | null, error: false };
    if (item.uri.startsWith('data:') || /^https?:\/\//i.test(item.uri)) {
      return { url: item.uri, error: false };
    }
    const cached = mediaUrlCache.get(mediaCacheKey(projectId, taskId, item.uri));
    if (cached?.status === 'ok') return { url: cached.url, error: false };
    if (cached?.status === 'error') return { url: null, error: true };
    return { url: null, error: false };
  };

  const immediate = getImmediate();
  const [url, setUrl] = useState<string | null>(immediate.url);
  const [error, setError] = useState<boolean>(immediate.error);
  const [loading, setLoading] = useState<boolean>(
    Boolean(enabled && item && !immediate.url && !immediate.error)
  );

  useEffect(() => {
    if (!item || !enabled) return;
    const snap = getImmediate();
    if (snap.url) {
      setUrl(snap.url);
      setError(false);
      setLoading(false);
      return;
    }
    if (snap.error) {
      setUrl(null);
      setError(true);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(false);
    void resolveMediaCached(item, projectId, taskId).then((resolved) => {
      if (!active) return;
      if (resolved) {
        setUrl(resolved);
        setError(false);
      } else {
        setUrl(null);
        setError(true);
      }
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [item?.uri, item?.kind, projectId, taskId, enabled]);

  return { url, loading, error };
}

const ImageThumbCard = memo(function ImageThumbCard({
  item,
  projectId,
  taskId,
  onOpen,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onOpen: (uri: string) => void;
  onSave: (item: TaskMediaItem) => void;
}) {
  const [containerRef, isVisible] = useVisibleOnce();
  const { url, loading, error } = useCachedMediaUrl(item, projectId, taskId, isVisible);

  return (
    <div
      ref={containerRef}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!error) onOpen(item.uri);
      }}
      onKeyDown={(e) => {
        if (!error && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(item.uri);
        }
      }}
      className={cn(
        'group relative aspect-[4/3] overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] transition-colors',
        error ? 'cursor-default opacity-50' : 'cursor-pointer hover:border-white/[0.22]'
      )}
    >
      {error ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] text-foreground-passive">
          <ImageIcon className="size-4 opacity-40" />
          <span className="truncate max-w-full">Dosya bulunamadı</span>
        </div>
      ) : loading || !url ? (
        <div className="flex size-full items-center justify-center">
          <Loader2 className="size-4 animate-spin text-foreground-passive" />
        </div>
      ) : (
        <img
          src={url}
          alt={item.name}
          loading="lazy"
          className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2 pt-4 pb-1.5">
        <div className="truncate text-[10.5px] font-medium text-white/95">{item.name}</div>
      </div>
      {!error && !item.uri.startsWith('data:') && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSave(item);
          }}
          title="İndir"
          aria-label="İndir"
          className="absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-lg bg-black/75 text-white/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-black/95 hover:text-white"
        >
          <Download className="size-3" />
        </button>
      )}
    </div>
  );
});

/** Koyu temaya tam uyumlu, sabit boyutlu ve yeniden çizimde kesilmeyen özel ses oynatıcı. */
const AudioMediaRow = memo(function AudioMediaRow({
  item,
  projectId,
  taskId,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onSave: (item: TaskMediaItem) => void;
}) {
  const [containerRef, isVisible] = useVisibleOnce();
  const [requested, setRequested] = useState(false);
  const { url, loading, error } = useCachedMediaUrl(
    item,
    projectId,
    taskId,
    isVisible || requested
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = () => {
    if (error) return;
    setRequested(true);
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (audio.paused) {
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5',
        error && 'opacity-50'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            disabled={error || loading || !url}
            onClick={togglePlay}
            aria-label={playing ? 'Duraklat' : 'Oynat'}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/[0.09] text-foreground transition-colors hover:bg-white/[0.16] disabled:cursor-default disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin text-foreground-muted" />
            ) : playing ? (
              <Pause className="size-3.5 fill-current" />
            ) : (
              <Play className="ml-0.5 size-3.5 fill-current" />
            )}
          </button>
          <div className="min-w-0">
            <div className="truncate text-[11.5px] font-medium text-foreground">{item.name}</div>
            <div className="flex items-center gap-1.5 text-[10px] text-foreground-passive">
              {item.folderHint && <span className="truncate">{item.folderHint}</span>}
              {error ? (
                <span>Dosya bulunamadı</span>
              ) : (
                <span className="font-mono tabular-nums">
                  {formatDuration(currentTime)}
                  {duration > 0 ? ` / ${formatDuration(duration)}` : ''}
                </span>
              )}
            </div>
          </div>
        </div>
        {!error && (
          <button
            type="button"
            onClick={() => onSave(item)}
            title="Kaydet"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-passive transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <Download className="size-3.5" />
          </button>
        )}
      </div>

      {/* İnce koyu ilerleme çubuğu */}
      {!error && (
        <div
          role="slider"
          aria-label="Ses konumu"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentTime)}
          tabIndex={0}
          onClick={(e) => {
            const audio = audioRef.current;
            if (!audio || !duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            audio.currentTime = ratio * duration;
            setCurrentTime(audio.currentTime);
          }}
          className="relative h-1.5 w-full cursor-pointer overflow-hidden rounded-full bg-white/[0.08]"
        >
          <div
            className="h-full rounded-full bg-sky-400/90 transition-[width] duration-100"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
          className="hidden"
        />
      )}
    </div>
  );
});

const VideoMediaCard = memo(function VideoMediaCard({
  item,
  projectId,
  taskId,
  onOpen,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onOpen: (uri: string) => void;
  onSave: (item: TaskMediaItem) => void;
}) {
  const [containerRef, isVisible] = useVisibleOnce();
  const { url, loading, error } = useCachedMediaUrl(item, projectId, taskId, isVisible);

  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03]',
        error && 'opacity-50'
      )}
    >
      <div className="relative aspect-video bg-black">
        {error ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-[11px] text-foreground-passive">
            <Film className="size-5 opacity-40" />
            <span>Video bulunamadı</span>
          </div>
        ) : loading || !url ? (
          <div className="flex size-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-foreground-passive" />
          </div>
        ) : (
          <video
            src={url}
            controls
            preload="metadata"
            className="size-full object-contain"
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Film className="size-3.5 shrink-0 text-sky-400" />
          <span className="truncate text-[11px] font-medium text-foreground">{item.name}</span>
        </div>
        {!error && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(item.uri)}
              title="Büyüt"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
            >
              <Maximize2 className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => onSave(item)}
              title="Kaydet"
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
            >
              <Download className="size-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

function MediaLightbox({
  items,
  activeUri,
  projectId,
  taskId,
  onSelectUri,
  onClose,
  onSave,
}: {
  items: readonly TaskMediaItem[];
  activeUri: string;
  projectId: string;
  taskId: string;
  onSelectUri: (uri: string) => void;
  onClose: () => void;
  onSave: (item: TaskMediaItem) => void;
}) {
  const index = items.findIndex((x) => x.uri === activeUri);
  const item = index >= 0 ? items[index]! : null;
  const { url, loading, error } = useCachedMediaUrl(item, projectId, taskId, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        const prev = items[index - 1];
        if (prev) onSelectUri(prev.uri);
      } else if (e.key === 'ArrowRight' && index >= 0 && index < items.length - 1) {
        e.preventDefault();
        const next = items[index + 1];
        if (next) onSelectUri(next.uri);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items, onSelectUri, onClose]);

  if (!item || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[140] flex flex-col bg-black/88 backdrop-blur-md"
    >
      <header
        onClick={(e) => e.stopPropagation()}
        className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] px-5 py-3"
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
          <div className="truncate font-mono text-[11px] text-foreground-passive">
            {item.uri.startsWith('data:') ? 'Gömülü görsel' : item.uri}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {items.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-xl border border-white/[0.1] bg-white/[0.04] p-0.5">
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => {
                  const prev = items[index - 1];
                  if (prev) onSelectUri(prev.uri);
                }}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-muted hover:bg-white/[0.08] hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="px-1.5 font-mono text-xs tabular-nums text-foreground-passive">
                {index + 1}/{items.length}
              </span>
              <button
                type="button"
                disabled={index >= items.length - 1}
                onClick={() => {
                  const next = items[index + 1];
                  if (next) onSelectUri(next.uri);
                }}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-muted hover:bg-white/[0.08] hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          {!item.uri.startsWith('data:') && (
            <button
              type="button"
              onClick={() => onSave(item)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/[0.1] bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-foreground hover:bg-white/[0.12]"
            >
              <Download className="size-3.5" />
              <span>Kaydet</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 cursor-pointer items-center justify-center rounded-xl text-foreground-muted hover:bg-white/[0.1] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div
        onClick={(e) => e.stopPropagation()}
        className="flex min-h-0 flex-1 items-center justify-center p-6"
      >
        {error ? (
          <div className="text-sm text-foreground-muted">Bu dosya okunamadı.</div>
        ) : loading || !url ? (
          <Loader2 className="size-6 animate-spin text-foreground-muted" />
        ) : item.kind === 'image' ? (
          <img
            src={url}
            alt={item.name}
            className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
          />
        ) : item.kind === 'video' ? (
          <video
            src={url}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-xl shadow-2xl"
          />
        ) : item.kind === 'audio' ? (
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-white/[0.1] bg-[#0e0e14] p-6">
            <Music className="size-10 text-violet-400" />
            <div className="text-sm font-medium text-foreground">{item.name}</div>
            <audio src={url} controls autoPlay className="w-full" />
          </div>
        ) : (
          <iframe src={url} title={item.name} className="size-full rounded-xl bg-white" />
        )}
      </div>
    </div>,
    document.body
  );
}

const PAGE_STEP = 24;

/** Sağ paneldeki veya büyütülmüş penceredeki derli toplu, sarsıntısız Medya ve Çıktılar galerisi. */
export const TaskMediaGalleryPanel = memo(function TaskMediaGalleryPanel({
  items,
  projectId,
  taskId,
  onClose,
}: {
  items: readonly TaskMediaItem[];
  projectId: string;
  taskId: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | TaskMediaKind>('all');
  const [expandedModal, setExpandedModal] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_STEP);

  // Filtre değişince sayfa limitini sıfırla
  useEffect(() => {
    setVisibleLimit(PAGE_STEP);
  }, [filter]);

  // Büyük modal açıkken Esc ile kapat
  useEffect(() => {
    if (!expandedModal || lightboxUri) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setExpandedModal(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedModal, lightboxUri]);

  const counts = useMemo(() => {
    const c = { image: 0, video: 0, audio: 0, pdf: 0 };
    for (const it of items) c[it.kind] += 1;
    return c;
  }, [items]);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((it) => it.kind === filter)),
    [items, filter]
  );

  const visibleItems = useMemo(
    () => filtered.slice(0, visibleLimit),
    [filtered, visibleLimit]
  );
  const remainingCount = Math.max(0, filtered.length - visibleItems.length);

  const videos = useMemo(() => visibleItems.filter((it) => it.kind === 'video'), [visibleItems]);
  const audios = useMemo(() => visibleItems.filter((it) => it.kind === 'audio'), [visibleItems]);
  const images = useMemo(() => visibleItems.filter((it) => it.kind === 'image'), [visibleItems]);
  const pdfs = useMemo(() => visibleItems.filter((it) => it.kind === 'pdf'), [visibleItems]);

  const handleSave = (item: TaskMediaItem) => {
    void (async () => {
      try {
        const saver = createTranscriptArtifactSaver({ projectId, taskId });
        const savedPath = await saver(item.artifact);
        if (savedPath) toast.success('Dosya kaydedildi', { description: savedPath });
      } catch (err) {
        toast.error('Kaydedilemedi', {
          description: err instanceof Error ? err.message : 'Bilinmeyen hata',
        });
      }
    })();
  };

  const renderFilters = () => {
    const tabs: Array<{ id: 'all' | TaskMediaKind; label: string; count: number }> = [
      { id: 'all', label: 'Tümü', count: items.length },
      ...(counts.image > 0 ? [{ id: 'image' as const, label: 'Görsel', count: counts.image }] : []),
      ...(counts.video > 0 ? [{ id: 'video' as const, label: 'Video', count: counts.video }] : []),
      ...(counts.audio > 0 ? [{ id: 'audio' as const, label: 'Ses', count: counts.audio }] : []),
      ...(counts.pdf > 0 ? [{ id: 'pdf' as const, label: 'Belge', count: counts.pdf }] : []),
    ];
    if (tabs.length <= 2) return null;
    return (
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-2.5 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={cn(
              'cursor-pointer rounded-lg px-2 py-0.5 text-[11px] transition-colors outline-none',
              filter === tab.id
                ? 'bg-white/[0.11] font-medium text-foreground'
                : 'text-foreground-passive hover:bg-white/[0.05] hover:text-foreground'
            )}
          >
            {tab.label} <span className="opacity-65">{tab.count}</span>
          </button>
        ))}
      </div>
    );
  };

  const renderContent = (wide: boolean) => (
    <div className="flex-1 space-y-4 overflow-y-auto p-2.5">
      {videos.length > 0 && (
        <section className="space-y-2">
          {filter === 'all' && (
            <div className="flex items-center gap-1.5 px-0.5 text-[10.5px] font-medium text-foreground-passive uppercase">
              <Film className="size-3" />
              <span>Videolar ({counts.video})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-2 gap-3' : 'space-y-2'}>
            {videos.map((item) => (
              <VideoMediaCard
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onOpen={setLightboxUri}
                onSave={handleSave}
              />
            ))}
          </div>
        </section>
      )}

      {audios.length > 0 && (
        <section className="space-y-2">
          {filter === 'all' && (
            <div className="flex items-center gap-1.5 px-0.5 text-[10.5px] font-medium text-foreground-passive uppercase">
              <Music className="size-3" />
              <span>Sesler ({counts.audio})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-2 gap-2.5' : 'space-y-2'}>
            {audios.map((item) => (
              <AudioMediaRow
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onSave={handleSave}
              />
            ))}
          </div>
        </section>
      )}

      {images.length > 0 && (
        <section className="space-y-2">
          {filter === 'all' && (
            <div className="flex items-center gap-1.5 px-0.5 text-[10.5px] font-medium text-foreground-passive uppercase">
              <ImageIcon className="size-3" />
              <span>Görseller ({counts.image})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-2 gap-2'}>
            {images.map((item) => (
              <ImageThumbCard
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onOpen={setLightboxUri}
                onSave={handleSave}
              />
            ))}
          </div>
        </section>
      )}

      {pdfs.length > 0 && (
        <section className="space-y-1.5">
          {filter === 'all' && (
            <div className="flex items-center gap-1.5 px-0.5 text-[10.5px] font-medium text-foreground-passive uppercase">
              <FileText className="size-3" />
              <span>Belgeler ({counts.pdf})</span>
            </div>
          )}
          <div className="space-y-1.5">
            {pdfs.map((item) => (
              <div
                key={item.id}
                onClick={() => setLightboxUri(item.uri)}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 hover:bg-white/[0.06]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="size-3.5 shrink-0 text-amber-400" />
                  <span className="truncate text-xs text-foreground">{item.name}</span>
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSave(item);
                  }}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
                >
                  <Download className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {remainingCount > 0 && (
        <button
          type="button"
          onClick={() => setVisibleLimit((n) => n + PAGE_STEP)}
          className="flex w-full cursor-pointer items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] py-2 text-xs font-medium text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
        >
          Daha fazla göster (+{remainingCount})
        </button>
      )}
    </div>
  );

  return (
    <>
      <aside className="mt-2.5 flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background-1">
        <header className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2">
          <div className="flex items-center gap-2">
            <Images className="size-3.5 text-foreground-passive" />
            <h2 className="text-xs font-medium text-foreground">Üretilen medya</h2>
            <span className="font-mono text-[11px] tabular-nums text-foreground-passive">
              {items.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpandedModal(true)}
              title="Büyük galeride aç"
              aria-label="Büyük galeride aç"
              className="flex size-6 cursor-pointer items-center justify-center rounded-lg text-foreground-passive transition-colors hover:bg-white/[0.08] hover:text-foreground"
            >
              <Maximize2 className="size-3" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Kapat"
              aria-label="Kapat"
              className="flex size-6 cursor-pointer items-center justify-center rounded-lg text-foreground-passive transition-colors hover:bg-white/[0.08] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </header>

        {renderFilters()}
        {renderContent(false)}
      </aside>

      {expandedModal && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              onClick={() => setExpandedModal(false)}
              className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-6 backdrop-blur-md"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="flex h-[min(86vh,820px)] w-[min(92vw,980px)] flex-col overflow-hidden rounded-3xl border border-white/[0.1] bg-[#09090d] shadow-[0_32px_90px_-12px_rgba(0,0,0,0.9)]"
              >
                <header className="flex shrink-0 items-center justify-between border-b border-white/[0.08] px-6 py-4">
                  <div className="flex items-center gap-2.5">
                    <Images className="size-4 text-foreground-muted" />
                    <h2 className="text-[15px] font-semibold text-foreground">
                      Üretilen Medya ve Çıktılar
                    </h2>
                    <span className="rounded-full bg-white/[0.07] px-2 py-0.5 font-mono text-[11px] text-foreground-muted">
                      {items.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedModal(false)}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-xl text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </header>
                {renderFilters()}
                {renderContent(true)}
              </div>
            </div>,
            document.body
          )
        : null}

      {lightboxUri !== null && (
        <MediaLightbox
          items={filtered}
          activeUri={lightboxUri}
          projectId={projectId}
          taskId={taskId}
          onSelectUri={setLightboxUri}
          onClose={() => setLightboxUri(null)}
          onSave={handleSave}
        />
      )}
    </>
  );
});
