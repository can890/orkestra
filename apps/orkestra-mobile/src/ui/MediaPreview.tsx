import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  artifactKind,
  formatDuration,
  formatFileSize,
  loadMediaPreview,
  peekMediaMetadata,
  safeDirectArtifactUrl,
  type LoadedMedia,
  type MediaArtifact,
} from '@/core/artifacts';
import {
  describeMediaError,
  isLegacyMediaHost,
  LEGACY_HOST_MAX_OFFSET,
  mediaStreams,
  type MediaProbeResult,
  type MediaSaveJob,
  type MediaSaveMode,
  type MediaSaveProgress,
} from '@/core/media-stream';
import { saveOrOpenNativeFile, triggerHaptic, type NativeFileAction } from '@/core/native-bridge';
import type { RemoteApi } from '@/core/wire-client';
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  MaximizeIcon,
  MusicIcon,
  ShareIcon,
  XIcon,
} from './icons';
import { pushOverlayBack } from './overlay-back';

/** Yalnızca otomatik PDF 1. sayfa küçük resmi için (bant genişliği); açma/indirme sınırsızdır. */
const PDF_THUMB_AUTO_MAX_BYTES = 16 * 1024 * 1024;
/** Uygulama içi metin penceresinde gösterilecek en büyük metin dosyası; büyükler yerel uygulamada açılır. */
const TEXT_MODAL_MAX_BYTES = 250_000;

function extensionLabel(name: string): string {
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  return (ext || 'DOSYA').slice(0, 6).toUpperCase();
}

function fileBadgeTone(name: string): string {
  const ext = extensionLabel(name).toLowerCase();
  if (ext === 'pdf') return 'is-pdf';
  if (ext === 'doc' || ext === 'docx' || ext === 'rtf') return 'is-doc';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'is-sheet';
  if (ext === 'ppt' || ext === 'pptx') return 'is-slide';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'is-archive';
  if (ext === 'apk') return 'is-apk';
  return '';
}

function fileTypeLabel(name: string, kind: string): string {
  const ext = extensionLabel(name).toLowerCase();
  if (kind === 'pdf' || ext === 'pdf') return 'PDF Belgesi';
  if (ext === 'doc' || ext === 'docx') return 'Word Belgesi';
  if (ext === 'xls' || ext === 'xlsx') return 'Excel Tablosu';
  if (ext === 'ppt' || ext === 'pptx') return 'Sunum Dosyası';
  if (ext === 'csv') return 'CSV Tablosu';
  if (ext === 'md') return 'Markdown';
  if (ext === 'json') return 'JSON Verisi';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'Sıkıştırılmış Arşiv';
  if (ext === 'apk') return 'Android Paketi';
  if (ext === 'epub') return 'E-Kitap';
  if (kind === 'text') return 'Metin / Kod';
  return 'Dosya';
}

async function resolveBlob(media: LoadedMedia): Promise<Blob> {
  if (media.blob) return media.blob;
  const resp = await fetch(media.url);
  return await resp.blob();
}

/** Yedek yol (doğrudan URL'ler ve yerel vekilin olmadığı ortamlar): Blob üzerinden teslim. */
async function deliverMedia(media: LoadedMedia, mode: NativeFileAction): Promise<boolean> {
  const blob = await resolveBlob(media);
  const handledNatively = await saveOrOpenNativeFile(
    blob,
    media.name,
    media.mimeType || blob.type || 'application/octet-stream',
    mode
  );
  if (handledNatively) return true;

  if (mode === 'share') {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        const file = new File([blob], media.name, { type: media.mimeType });
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: media.name, files: [file] });
          return true;
        }
      }
    } catch {
      // Paylaşım iptal edildiyse indirmeye düş.
    }
  }

  const a = document.createElement('a');
  a.href = media.url;
  a.download = media.name;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return true;
}

/** Kart ekrana (yakınına) bir kez geldiğinde `true` olur; sonra öyle kalır. */
function useInView<T extends Element>(rootMargin = '360px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen];
}

type RemoteMedia = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  name: string;
  mimeType: string;
  size: number;
  /** Oynatılabilir/gösterilebilir adres (yerel vekil, doğrudan URL ya da Blob). */
  url?: string;
  /** Yerel vekil akış kimliği (indir/aç/paylaş ve önizleme bununla yapılır). */
  streamId?: string;
  /** Tarayıcı yedeğinde yüklenen tam dosya. */
  loaded?: LoadedMedia;
  snippet?: string;
  legacyHost: boolean;
  error?: string;
};

/**
 * Kart görününce: boyut/tür için ilk 4 KB'ı okur, ardından Android'de dosyayı yerel vekile
 * kaydeder (bayt tutulmaz). Yerel vekil yoksa ve `needUrl` ise tam dosyayı Blob'a yükler.
 */
function useRemoteMedia(
  api: RemoteApi,
  conversationId: string,
  artifact: MediaArtifact,
  enabled: boolean,
  needUrl: boolean
): RemoteMedia {
  const [state, setState] = useState<RemoteMedia>({
    status: 'idle',
    name: artifact.name,
    mimeType: artifact.mimeType ?? 'application/octet-stream',
    size: 0,
    legacyHost: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const direct = safeDirectArtifactUrl(artifact.uri);
    if (direct) {
      setState((prev) => ({ ...prev, status: 'ready', url: direct }));
      return;
    }
    setState((prev) => ({ ...prev, status: 'loading', error: undefined }));
    void (async () => {
      try {
        const meta = await peekMediaMetadata(api, conversationId, artifact);
        if (!active) return;
        const base: RemoteMedia = {
          status: 'ready',
          name: meta.name,
          mimeType: meta.mimeType,
          size: meta.size,
          snippet: meta.snippet,
          legacyHost: isLegacyMediaHost(meta),
        };
        const stream = mediaStreams.open(api, conversationId, artifact.uri, meta);
        if (stream) {
          setState({ ...base, url: stream.url, streamId: stream.streamId });
          return;
        }
        if (!needUrl) {
          setState(base);
          return;
        }
        setState({ ...base, status: 'loading' });
        const loaded = await loadMediaPreview(api, conversationId, artifact);
        if (active) setState({ ...base, url: loaded.url, loaded });
      } catch (cause) {
        if (active) {
          setState((prev) => ({ ...prev, status: 'error', error: describeMediaError(cause) }));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, conversationId, artifact, enabled, needUrl]);

  return state;
}

/** Akış hatası (ör. oynatma sırasında eski masaüstü sınırı) dinleyicisi. */
function useStreamError(
  streamId: string | undefined
): [string | null, (message: string | null) => void] {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!streamId) return;
    return mediaStreams.onError(streamId, (message) => setError(message));
  }, [streamId]);
  return [error, setError];
}

function useProbe(
  streamId: string | undefined,
  kind: 'video' | 'audio' | 'pdf',
  enabled = true
): MediaProbeResult | null {
  const [probe, setProbe] = useState<MediaProbeResult | null>(null);
  useEffect(() => {
    if (!streamId || !enabled) return;
    let active = true;
    void mediaStreams.probe(streamId, kind).then((result) => {
      if (active && result) setProbe(result);
    });
    return () => {
      active = false;
    };
  }, [streamId, kind, enabled]);
  return probe;
}

type Saver = {
  busy: MediaSaveMode | null;
  progress: MediaSaveProgress | null;
  downloaded: boolean;
  error: string | null;
  run(mode: MediaSaveMode): Promise<void>;
};

/**
 * İndir / aç / paylaş. Android'de dosya yerel tarafta parça parça akıtılır (boyut sınırı yok,
 * JS belleğine girmez); aynı düğmeye yeniden dokunmak süren aktarımı iptal eder.
 */
function useSaver(
  api: RemoteApi,
  conversationId: string,
  artifact: MediaArtifact,
  media: RemoteMedia
): Saver {
  const [busy, setBusy] = useState<MediaSaveMode | null>(null);
  const [progress, setProgress] = useState<MediaSaveProgress | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobRef = useRef<MediaSaveJob | null>(null);

  async function run(mode: MediaSaveMode): Promise<void> {
    if (busy) {
      if (busy === mode) jobRef.current?.cancel();
      return;
    }
    if (media.status === 'error') {
      setError(media.error ?? null);
      return;
    }
    setBusy(mode);
    setError(null);
    setProgress(null);
    triggerHaptic(mode === 'download' ? 'medium' : 'light');
    try {
      if (media.streamId) {
        const job = mediaStreams.save(media.streamId, mode, setProgress);
        if (!job) throw new Error('Dosya telefona aktarılamadı.');
        jobRef.current = job;
        await job.done;
      } else {
        const loaded = media.loaded ?? (await loadMediaPreview(api, conversationId, artifact));
        if (!(await deliverMedia(loaded, mode))) throw new Error('Dosya telefona kaydedilemedi.');
      }
      if (mode === 'download') {
        setDownloaded(true);
        triggerHaptic('success');
      }
    } catch (cause) {
      const message = describeMediaError(cause);
      if (!/İptal/.test(message)) setError(message);
    } finally {
      jobRef.current = null;
      setBusy(null);
      setProgress(null);
    }
  }

  return { busy, progress, downloaded, error, run };
}

function progressText(saver: Saver): string | null {
  if (!saver.busy) return null;
  const verb = saver.busy === 'download' ? 'İndiriliyor' : 'Hazırlanıyor';
  const p = saver.progress;
  if (!p || p.total <= 0) return `${verb}…`;
  const pct = Math.min(100, Math.floor((p.written / p.total) * 100));
  return `${verb} %${pct} · ${formatFileSize(p.written) || '0 B'} / ${formatFileSize(p.total)} · iptal için tekrar dokun`;
}

function DownloadButton(props: { saver: Saver; label: string; className?: string; size?: number }) {
  const { saver } = props;
  return (
    <button
      type="button"
      className={`${props.className ?? 'wb-icon-btn sm'}${saver.downloaded ? ' is-done' : ''}`}
      onClick={() => void saver.run('download')}
      aria-label={saver.busy === 'download' ? 'İndirmeyi iptal et' : props.label}
      title={saver.busy === 'download' ? 'İptal' : 'İndir'}
    >
      {saver.busy === 'download' ? (
        <span className="spinner xs" />
      ) : saver.downloaded ? (
        <CheckIcon size={props.size ?? 15} />
      ) : (
        <DownloadIcon size={props.size ?? 15} />
      )}
    </button>
  );
}

type LightboxState = { url: string; name: string; size: number; saver: Saver };

export function MediaArtifactStrip(props: {
  api: RemoteApi;
  conversationId: string;
  artifacts: readonly MediaArtifact[];
}) {
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [textModal, setTextModal] = useState<{ loaded: LoadedMedia; saver: Saver } | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    return pushOverlayBack(() => setLightbox(null));
  }, [lightbox]);
  useEffect(() => {
    if (!textModal) return;
    return pushOverlayBack(() => setTextModal(null));
  }, [textModal]);

  if (props.artifacts.length === 0) return null;

  const images = props.artifacts.filter((a) => artifactKind(a) === 'image');
  const videos = props.artifacts.filter((a) => artifactKind(a) === 'video');
  const others = props.artifacts.filter((a) => {
    const kind = artifactKind(a);
    return kind !== 'image' && kind !== 'video';
  });

  return (
    <div className="media-artifact-strip">
      {images.length > 0 ? (
        <div className={`media-image-grid ${images.length === 1 ? 'is-single' : 'is-multi'}`}>
          {images.map((item) => (
            <ImageArtifactCard
              key={item.uri}
              api={props.api}
              conversationId={props.conversationId}
              artifact={item}
              onOpenLightbox={(state) => {
                triggerHaptic('light');
                setLightbox(state);
              }}
            />
          ))}
        </div>
      ) : null}

      {videos.length > 0 ? (
        <div className={`media-video-gallery ${videos.length > 1 ? 'is-multi' : 'is-single'}`}>
          {videos.map((item) => (
            <VideoArtifactCard
              key={item.uri}
              api={props.api}
              conversationId={props.conversationId}
              artifact={item}
            />
          ))}
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="media-file-stack">
          {others.map((item) =>
            artifactKind(item) === 'audio' ? (
              <AudioArtifactCard
                key={item.uri}
                api={props.api}
                conversationId={props.conversationId}
                artifact={item}
              />
            ) : (
              <FileArtifactCard
                key={item.uri}
                api={props.api}
                conversationId={props.conversationId}
                artifact={item}
                onOpenText={(loaded, saver) => {
                  triggerHaptic('light');
                  setTextModal({ loaded, saver });
                }}
              />
            )
          )}
        </div>
      ) : null}

      {lightbox ? (
        <div
          className="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.name}
          onClick={() => setLightbox(null)}
        >
          <div className="media-lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <div className="media-lightbox-meta">
              <strong className="media-lightbox-name">{lightbox.name}</strong>
              {lightbox.size > 0 ? (
                <span className="media-lightbox-size mono">{formatFileSize(lightbox.size)}</span>
              ) : null}
            </div>
            <div className="media-lightbox-actions">
              <button
                type="button"
                className="wb-icon-btn sm media-lightbox-btn"
                onClick={() => void lightbox.saver.run('download')}
                aria-label="Telefona indir"
                title="İndirilenler/Sovra klasörüne kaydet"
              >
                <DownloadIcon size={16} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm media-lightbox-btn"
                onClick={() => void lightbox.saver.run('share')}
                aria-label="Paylaş"
                title="Paylaş"
              >
                <ShareIcon size={16} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm media-lightbox-btn"
                onClick={() => setLightbox(null)}
                aria-label="Kapat"
              >
                <XIcon size={18} />
              </button>
            </div>
          </div>
          <div className="media-lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <img src={lightbox.url} alt={lightbox.name} className="media-lightbox-img" />
          </div>
        </div>
      ) : null}

      {textModal ? (
        <div
          className="sheet-layer"
          role="dialog"
          aria-modal="true"
          aria-label={textModal.loaded.name}
        >
          <div className="sheet-backdrop" onClick={() => setTextModal(null)} />
          <div className="sheet-panel diff-sheet-panel">
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <div className="sheet-title-group">
                <h2 className="sheet-title">{textModal.loaded.name}</h2>
                {textModal.loaded.size > 0 ? (
                  <p className="sheet-subtitle mono">{formatFileSize(textModal.loaded.size)}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="wb-icon-btn sm"
                onClick={() => void textModal.saver.run('download')}
                aria-label="Telefona indir"
                title="İndirilenler/Sovra klasörüne kaydet"
              >
                <DownloadIcon size={15} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm"
                onClick={() => void textModal.saver.run('share')}
                aria-label="Paylaş"
              >
                <ShareIcon size={15} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm"
                onClick={() => setTextModal(null)}
                aria-label="Kapat"
              >
                <XIcon size={17} />
              </button>
            </div>
            <div className="sheet-body">
              <pre className="media-text-preview mono">{textModal.loaded.textContent ?? ''}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImageArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
  onOpenLightbox: (state: LightboxState) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const media = useRemoteMedia(props.api, props.conversationId, props.artifact, inView, true);
  const saver = useSaver(props.api, props.conversationId, props.artifact, media);
  const [broken, setBroken] = useState(false);

  if (media.status === 'error' || broken) {
    return (
      <div ref={ref} className="media-fallback-pill" title={media.error}>
        <FileCodeIcon size={14} />
        <span className="media-fallback-name">{props.artifact.name}</span>
      </div>
    );
  }

  if (!media.url) {
    return (
      <div
        ref={ref}
        className="media-image-skeleton"
        aria-label={`${props.artifact.name} yükleniyor`}
      >
        {media.status === 'loading' ? <span className="spinner xs" /> : null}
        <span className="media-skeleton-name">{props.artifact.name}</span>
      </div>
    );
  }

  const url = media.url;
  return (
    <div ref={ref} className="media-image-card-wrap">
      <button
        type="button"
        className="media-image-card"
        onClick={() => props.onOpenLightbox({ url, name: media.name, size: media.size, saver })}
        aria-label={`${media.name} görselini büyüt`}
      >
        <img
          src={url}
          alt={media.name}
          className="media-image-el"
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
        <span className="media-image-caption">
          <span className="media-image-caption-name">{media.name}</span>
          {media.size > 0 ? (
            <span className="media-image-caption-size mono">{formatFileSize(media.size)}</span>
          ) : null}
        </span>
      </button>
      <DownloadButton
        saver={saver}
        label={`${media.name} görselini indir`}
        className="media-image-quick-dl"
        size={14}
      />
    </div>
  );
}

/** Video sahnesinin en-boy oranı: dikey videolar ekranı taşmasın diye genişlik daraltılır. */
function stageStyle(width?: number, height?: number): CSSProperties {
  const ratio = width && height ? width / height : 16 / 9;
  const clamped = Math.max(0.42, Math.min(2.6, ratio));
  return {
    aspectRatio: String(clamped),
    width:
      clamped < 1 ? `min(100%, calc(var(--media-stage-max-h) * ${clamped.toFixed(4)}))` : '100%',
  };
}

type ViewerState = { startAt: number; autoPlay: boolean };

function VideoArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const media = useRemoteMedia(props.api, props.conversationId, props.artifact, inView, true);
  const saver = useSaver(props.api, props.conversationId, props.artifact, media);
  const probe = useProbe(media.streamId, 'video');
  const [streamError, setStreamError] = useStreamError(media.streamId);
  const [natural, setNatural] = useState<{ w: number; h: number; durationMs?: number } | null>(
    null
  );
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!viewer) return;
    return pushOverlayBack(() => setViewer(null));
  }, [viewer]);

  const width = probe?.width ?? natural?.w;
  const height = probe?.height ?? natural?.h;
  const durationText = formatDuration(probe?.durationMs ?? natural?.durationMs);
  const sizeText = formatFileSize(media.size);
  const resolution = width && height ? `${width}×${height}` : '';
  const error = media.error ?? streamError;
  const legacyHint =
    !error && media.legacyHost && media.streamId && media.size > LEGACY_HOST_MAX_OFFSET
      ? 'Masaüstü eski sürüm: videonun sonu oynatılamayabilir, güncelleyin.'
      : null;
  const sub =
    error ??
    saver.error ??
    progressText(saver) ??
    legacyHint ??
    ([durationText, resolution, sizeText].filter(Boolean).join(' · ') || 'Video');

  function openViewer(): void {
    const el = videoRef.current;
    const startAt = el ? el.currentTime : 0;
    const autoPlay = el ? !el.paused : false;
    el?.pause();
    triggerHaptic('light');
    setViewer({ startAt, autoPlay });
  }

  return (
    <div ref={ref} className="media-video-card">
      <div className="media-video-stage" style={stageStyle(width, height)}>
        {media.url && !error ? (
          <video
            ref={videoRef}
            src={media.url}
            poster={probe?.thumbnail}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload nofullscreen noremoteplayback"
            disablePictureInPicture
            className="media-video-el"
            onLoadedMetadata={(event) => {
              const el = event.currentTarget;
              setNatural({
                w: el.videoWidth,
                h: el.videoHeight,
                durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : undefined,
              });
            }}
            onError={() => {
              setStreamError(
                (media.streamId ? mediaStreams.lastError(media.streamId) : null) ??
                  'Video oynatılamadı (biçim bu telefonda desteklenmiyor olabilir).'
              );
            }}
          />
        ) : (
          <div className="media-video-placeholder">
            {error ? (
              <span className="media-video-error">{error}</span>
            ) : media.status === 'loading' ? (
              <span className="spinner xs" />
            ) : null}
          </div>
        )}
        {media.url && !error ? (
          <button
            type="button"
            className="media-video-expand"
            onClick={openViewer}
            aria-label="Tam ekran oynat"
            title="Tam ekran"
          >
            <MaximizeIcon size={15} />
          </button>
        ) : null}
      </div>
      <div className="media-video-meta">
        <div className="media-file-info">
          <strong className="media-file-name">{media.name}</strong>
          <span className={`media-file-sub${error || saver.error ? ' is-error' : ''}`}>{sub}</span>
        </div>
        <DownloadButton saver={saver} label="Videoyu telefona indir" />
        <button
          type="button"
          className="wb-icon-btn sm"
          onClick={() => void saver.run('share')}
          aria-label="Videoyu paylaş"
          title="Paylaş"
          disabled={saver.busy !== null && saver.busy !== 'share'}
        >
          {saver.busy === 'share' ? <span className="spinner xs" /> : <ShareIcon size={15} />}
        </button>
      </div>

      {viewer && media.url ? (
        <VideoViewer
          url={media.url}
          name={media.name}
          meta={[durationText, sizeText].filter(Boolean).join(' · ')}
          poster={probe?.thumbnail}
          startAt={viewer.startAt}
          autoPlay={viewer.autoPlay}
          saver={saver}
          onClose={(time) => {
            setViewer(null);
            const el = videoRef.current;
            if (el && Number.isFinite(time)) el.currentTime = time;
          }}
        />
      ) : null}
    </div>
  );
}

/** Tam ekran video katmanı (WebView'ın yerel tam ekranı bu uygulamada kullanılamıyor). */
function VideoViewer(props: {
  url: string;
  name: string;
  meta: string;
  poster?: string;
  startAt: number;
  autoPlay: boolean;
  saver: Saver;
  onClose: (time: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { startAt, autoPlay } = props;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (startAt > 0) el.currentTime = startAt;
    if (autoPlay) void el.play().catch(() => {});
  }, [startAt, autoPlay]);

  const close = () => props.onClose(videoRef.current?.currentTime ?? 0);

  return (
    <div
      className="media-lightbox media-video-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={props.name}
    >
      <div className="media-lightbox-bar">
        <div className="media-lightbox-meta">
          <strong className="media-lightbox-name">{props.name}</strong>
          {props.meta ? <span className="media-lightbox-size mono">{props.meta}</span> : null}
        </div>
        <div className="media-lightbox-actions">
          <button
            type="button"
            className="wb-icon-btn sm media-lightbox-btn"
            onClick={() => void props.saver.run('download')}
            aria-label="Telefona indir"
          >
            {props.saver.busy === 'download' ? (
              <span className="spinner xs" />
            ) : (
              <DownloadIcon size={16} />
            )}
          </button>
          <button
            type="button"
            className="wb-icon-btn sm media-lightbox-btn"
            onClick={() => void props.saver.run('share')}
            aria-label="Paylaş"
          >
            <ShareIcon size={16} />
          </button>
          <button
            type="button"
            className="wb-icon-btn sm media-lightbox-btn"
            onClick={close}
            aria-label="Kapat"
          >
            <XIcon size={18} />
          </button>
        </div>
      </div>
      <div className="media-video-viewer-stage">
        <video
          ref={videoRef}
          src={props.url}
          poster={props.poster}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload nofullscreen noremoteplayback"
          disablePictureInPicture
          className="media-video-viewer-el"
        />
      </div>
    </div>
  );
}

function AudioArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const media = useRemoteMedia(props.api, props.conversationId, props.artifact, inView, true);
  const saver = useSaver(props.api, props.conversationId, props.artifact, media);
  const [streamError, setStreamError] = useStreamError(media.streamId);
  const [durationMs, setDurationMs] = useState<number | undefined>(undefined);

  const error = media.error ?? streamError;
  const sub =
    error ??
    saver.error ??
    progressText(saver) ??
    ([formatDuration(durationMs), formatFileSize(media.size)].filter(Boolean).join(' · ') ||
      'Ses dosyası');

  return (
    <div ref={ref} className="media-audio-card">
      <div className="media-audio-head">
        <span className="media-audio-icon" aria-hidden="true">
          <MusicIcon size={16} />
        </span>
        <div className="media-file-info">
          <strong className="media-file-name">{media.name}</strong>
          <span className={`media-file-sub${error || saver.error ? ' is-error' : ''}`}>{sub}</span>
        </div>
        <DownloadButton saver={saver} label="Sesi telefona indir" />
      </div>
      {media.url && !error ? (
        <audio
          src={media.url}
          controls
          preload="metadata"
          controlsList="nodownload"
          className="media-audio-el"
          onLoadedMetadata={(event) => {
            const d = event.currentTarget.duration;
            if (Number.isFinite(d)) setDurationMs(d * 1000);
          }}
          onError={() =>
            setStreamError(
              (media.streamId ? mediaStreams.lastError(media.streamId) : null) ??
                'Ses oynatılamadı (biçim bu telefonda desteklenmiyor olabilir).'
            )
          }
        />
      ) : error ? null : (
        <div className="media-audio-placeholder" aria-hidden="true">
          {media.status === 'loading' ? <span className="spinner xs" /> : null}
        </div>
      )}
    </div>
  );
}

function FileArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
  onOpenText: (loaded: LoadedMedia, saver: Saver) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const media = useRemoteMedia(props.api, props.conversationId, props.artifact, inView, false);
  const saver = useSaver(props.api, props.conversationId, props.artifact, media);
  const [openingText, setOpeningText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  const kind = artifactKind(props.artifact);
  const isPdf = kind === 'pdf';
  const badgeTone = fileBadgeTone(props.artifact.name);
  // WhatsApp/Telegram tarzı: küçük PDF'lerde 1. sayfa önizlemesi sessizce hazırlanır.
  const pdfPreview = useProbe(
    media.streamId,
    'pdf',
    isPdf && media.size > 0 && media.size <= PDF_THUMB_AUTO_MAX_BYTES
  );

  const isText =
    kind === 'text' || media.mimeType.startsWith('text/') || media.mimeType === 'application/json';

  async function handleOpen(): Promise<void> {
    if (saver.busy || openingText) return;
    if (isText && media.size > 0 && media.size <= TEXT_MODAL_MAX_BYTES) {
      setOpeningText(true);
      setTextError(null);
      try {
        const loaded = await loadMediaPreview(props.api, props.conversationId, props.artifact);
        if (loaded.textContent !== undefined) {
          props.onOpenText(loaded, saver);
          return;
        }
      } catch (cause) {
        setTextError(describeMediaError(cause));
        return;
      } finally {
        setOpeningText(false);
      }
    }
    await saver.run('open');
  }

  const sizeText = formatFileSize(media.size);
  const pageText = pdfPreview?.pageCount ? `${pdfPreview.pageCount} sayfa` : '';
  const metaLine = [pageText, sizeText, fileTypeLabel(props.artifact.name, kind)]
    .filter(Boolean)
    .join(' · ');
  const error = media.error ?? textError ?? saver.error;
  const sub =
    error ??
    progressText(saver) ??
    (openingText
      ? 'Açılıyor…'
      : saver.downloaded
        ? `İndirildi${sizeText ? ` · ${sizeText}` : ''} · Açmak için dokun`
        : metaLine || 'Telefonda açmak ve indirmek için dokun');
  const busy = Boolean(saver.busy) || openingText;

  return (
    <div ref={ref} className={`media-rich-card ${badgeTone}`}>
      {isPdf && pdfPreview?.thumbnail ? (
        <button
          type="button"
          className="media-pdf-preview-stage"
          disabled={busy}
          onClick={() => void handleOpen()}
          aria-label={`${props.artifact.name} PDF önizlemesini aç`}
        >
          <img
            src={pdfPreview.thumbnail}
            alt={`${props.artifact.name} ilk sayfa önizlemesi`}
            className="media-pdf-page-img"
          />
          <span className="media-pdf-stage-fade" aria-hidden="true" />
          <span className="media-pdf-pill-tag">PDF</span>
          {pageText ? <span className="media-corner-pill mono">{pageText}</span> : null}
        </button>
      ) : null}

      {!isPdf && media.snippet ? (
        <button
          type="button"
          className="media-snippet-stage"
          disabled={busy}
          onClick={() => void handleOpen()}
          aria-label={`${props.artifact.name} içeriğini aç`}
        >
          <pre className="media-snippet-pre mono">{media.snippet}</pre>
          <span className="media-snippet-fade" aria-hidden="true" />
        </button>
      ) : null}

      <div className="media-rich-foot">
        <button
          type="button"
          className="media-file-main-btn"
          disabled={busy && saver.busy !== 'open'}
          onClick={() => void (saver.busy === 'open' ? saver.run('open') : handleOpen())}
        >
          <span className={`media-ext-badge ${badgeTone}`}>
            {extensionLabel(props.artifact.name)}
          </span>
          <span className="media-file-info">
            <strong className="media-file-name">{media.name}</strong>
            <span className={`media-file-sub${error ? ' is-error' : ''}`}>{sub}</span>
          </span>
          <ExternalLinkIcon size={14} className="icon-passive" />
        </button>
        <DownloadButton
          saver={saver}
          label={`${props.artifact.name} dosyasını telefona indir`}
          className="media-file-dl-btn"
        />
      </div>
    </div>
  );
}
