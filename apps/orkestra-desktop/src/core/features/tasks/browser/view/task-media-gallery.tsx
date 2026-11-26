import type { ToolNode, TranscriptTurn } from '@orkestra/chat-ui';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import {
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Images,
  Loader2,
  Maximize2,
  Music,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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

const MEDIA_PATH_RE =
  /(?:file:\/\/)?((?:\/[A-Za-z0-9._@+\-/ ]+|[A-Za-z0-9._\-/]+\/[A-Za-z0-9._\-/]+)\.(?:png|jpe?g|webp|gif|avif|mp4|m4v|webm|mov|mp3|wav|m4a|ogg|aac|flac|pdf))\b/gi;

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
    const ext = uri.match(/^data:[^/]+\/([a-z0-9+.-]+);/i)?.[1] ?? 'bin';
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
    // Büyük base64 görselleri hızlı tekilleştir
    return `data:${uri.length}:${uri.slice(0, 80)}:${uri.slice(-32)}`;
  }
  return uri.replace(/^file:\/\//i, '').replace(/^sandbox:/i, '').trim();
}

function extractPathsFromText(text: string | undefined): string[] {
  if (!text) return [];
  const results: string[] = [];
  MEDIA_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEDIA_PATH_RE.exec(text)) !== null) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    // URL parçaları veya geçersiz boşluklu uzun satırları ele
    if (candidate.length > 260 || candidate.includes('  ')) continue;
    if (candidate.includes('/node_modules/') || candidate.includes('/.git/')) continue;
    results.push(candidate);
  }
  return results;
}

/**
 * Görevdeki tüm konuşma turlarından (mesajlar, araç çıktıları ve alt ajanlar)
 * üretilen veya işlenen tüm görsel, video, ses ve PDF dosyalarını tekilleştirerek toplar.
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
      id: `${kind}:${collected.length}:${key.slice(0, 60)}`,
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
        pushPaths(node.outputText);
        pushPaths(node.command);
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

  // En son üretilenler en üstte görünsün
  return collected.reverse();
}

/** Tek bir medya öğesi için gerçek URL'yi (yerel veya SSH) çözer. */
function useResolvedMediaUrl(
  item: TaskMediaItem | null,
  projectId: string,
  taskId: string
): { url: string | null; loading: boolean; error: boolean } {
  const [url, setUrl] = useState<string | null>(
    item?.uri.startsWith('data:') ? item.uri : null
  );
  const [loading, setLoading] = useState(Boolean(item && !item.uri.startsWith('data:')));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item) {
      setUrl(null);
      setLoading(false);
      setError(false);
      return;
    }
    if (item.uri.startsWith('data:') || /^https?:\/\//i.test(item.uri)) {
      setUrl(item.uri);
      setLoading(false);
      setError(false);
      return;
    }

    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    let active = true;
    setLoading(true);
    setError(false);

    const run = async () => {
      try {
        if (item.kind === 'video' || item.kind === 'audio' || item.kind === 'pdf') {
          const mediaUrl = createTranscriptArtifactMediaUrl({ projectId, taskId });
          const res = await mediaUrl(item.artifact, { signal: controller.signal });
          if (!active) {
            res.dispose?.();
            return;
          }
          dispose = res.dispose;
          setUrl(res.url);
        } else {
          const resolve = createTranscriptArtifactResolver({ projectId, taskId });
          const res = await resolve(item.artifact, { signal: controller.signal });
          if (!active) {
            res.dispose?.();
            return;
          }
          dispose = res.dispose;
          setUrl(res.url);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
      dispose?.();
    };
  }, [item?.uri, item?.kind, projectId, taskId]);

  return { url, loading, error };
}

function ImageThumbCard({
  item,
  projectId,
  taskId,
  onOpen,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onOpen: () => void;
  onSave: () => void;
}) {
  const { url, loading, error } = useResolvedMediaUrl(item, projectId, taskId);
  if (error) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03] transition-all hover:border-white/[0.2]"
    >
      {loading || !url ? (
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
      {!item.uri.startsWith('data:') && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSave();
          }}
          title="İndir"
          aria-label="İndir"
          className="absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-lg bg-black/70 text-white/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-black/90 hover:text-white"
        >
          <Download className="size-3" />
        </button>
      )}
    </div>
  );
}

function AudioMediaRow({
  item,
  projectId,
  taskId,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onSave: () => void;
}) {
  const { url, loading, error } = useResolvedMediaUrl(item, projectId, taskId);
  if (error) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
            <Music className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[11.5px] font-medium text-foreground">{item.name}</div>
            {item.folderHint && (
              <div className="truncate text-[10px] text-foreground-passive">{item.folderHint}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onSave}
          title="Kaydet"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-passive transition-colors hover:bg-white/[0.08] hover:text-foreground"
        >
          <Download className="size-3.5" />
        </button>
      </div>
      {loading || !url ? (
        <div className="flex h-8 items-center gap-1.5 text-[11px] text-foreground-passive">
          <Loader2 className="size-3 animate-spin" />
          <span>Ses yükleniyor…</span>
        </div>
      ) : (
        <audio src={url} controls preload="metadata" className="h-8 w-full" />
      )}
    </div>
  );
}

function VideoMediaCard({
  item,
  projectId,
  taskId,
  onOpen,
  onSave,
}: {
  item: TaskMediaItem;
  projectId: string;
  taskId: string;
  onOpen: () => void;
  onSave: () => void;
}) {
  const { url, loading, error } = useResolvedMediaUrl(item, projectId, taskId);
  if (error) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.03]">
      <div className="relative aspect-video bg-black">
        {loading || !url ? (
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
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onOpen}
            title="Büyüt"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
          >
            <Maximize2 className="size-3" />
          </button>
          <button
            type="button"
            onClick={onSave}
            title="Kaydet"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-passive hover:bg-white/[0.08] hover:text-foreground"
          >
            <Download className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MediaLightbox({
  items,
  index,
  projectId,
  taskId,
  onChangeIndex,
  onClose,
  onSave,
}: {
  items: readonly TaskMediaItem[];
  index: number;
  projectId: string;
  taskId: string;
  onChangeIndex: (next: number) => void;
  onClose: () => void;
  onSave: (item: TaskMediaItem) => void;
}) {
  const item = items[index] ?? null;
  const { url, loading } = useResolvedMediaUrl(item, projectId, taskId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        onChangeIndex(index - 1);
      } else if (e.key === 'ArrowRight' && index < items.length - 1) {
        e.preventDefault();
        onChangeIndex(index + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onChangeIndex, onClose]);

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
                onClick={() => onChangeIndex(index - 1)}
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
                onClick={() => onChangeIndex(index + 1)}
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
        {loading || !url ? (
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

/** Sağ paneldeki veya büyütülmüş penceredeki derli toplu Medya ve Çıktılar galerisi. */
export function TaskMediaGalleryPanel({
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
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const counts = useMemo(() => {
    const c = { image: 0, video: 0, audio: 0, pdf: 0 };
    for (const it of items) c[it.kind] += 1;
    return c;
  }, [items]);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((it) => it.kind === filter)),
    [items, filter]
  );

  const images = filtered.filter((it) => it.kind === 'image');
  const videos = filtered.filter((it) => it.kind === 'video');
  const audios = filtered.filter((it) => it.kind === 'audio');
  const pdfs = filtered.filter((it) => it.kind === 'pdf');

  const handleSave = async (item: TaskMediaItem) => {
    try {
      const saver = createTranscriptArtifactSaver({ projectId, taskId });
      const savedPath = await saver(item.artifact);
      if (savedPath) toast.success('Dosya kaydedildi', { description: savedPath });
    } catch (err) {
      toast.error('Kaydedilemedi', {
        description: err instanceof Error ? err.message : 'Bilinmeyen hata',
      });
    }
  };

  const openLightboxFor = (item: TaskMediaItem) => {
    const idx = filtered.findIndex((x) => x.id === item.id);
    if (idx >= 0) setLightboxIndex(idx);
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
              'cursor-pointer rounded-lg px-2 py-0.5 text-[11px] transition-colors',
              filter === tab.id
                ? 'bg-white/[0.1] font-medium text-foreground'
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
              <span>Videolar ({videos.length})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-2 gap-3' : 'space-y-2'}>
            {videos.map((item) => (
              <VideoMediaCard
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onOpen={() => openLightboxFor(item)}
                onSave={() => void handleSave(item)}
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
              <span>Sesler ({audios.length})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-2 gap-2.5' : 'space-y-2'}>
            {audios.map((item) => (
              <AudioMediaRow
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onSave={() => void handleSave(item)}
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
              <span>Görseller ({images.length})</span>
            </div>
          )}
          <div className={wide ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-2 gap-2'}>
            {images.map((item) => (
              <ImageThumbCard
                key={item.id}
                item={item}
                projectId={projectId}
                taskId={taskId}
                onOpen={() => openLightboxFor(item)}
                onSave={() => void handleSave(item)}
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
              <span>Belgeler ({pdfs.length})</span>
            </div>
          )}
          <div className="space-y-1.5">
            {pdfs.map((item) => (
              <div
                key={item.id}
                onClick={() => openLightboxFor(item)}
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
                    void handleSave(item);
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

      {lightboxIndex !== null && (
        <MediaLightbox
          items={filtered}
          index={lightboxIndex}
          projectId={projectId}
          taskId={taskId}
          onChangeIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onSave={(it) => void handleSave(it)}
        />
      )}
    </>
  );
}
