import { useEffect, useState } from 'react';
import {
  artifactKind,
  formatDuration,
  formatFileSize,
  loadMediaPreview,
  peekMediaMetadata,
  type LoadedMedia,
  type MediaArtifact,
  type PeekedMedia,
} from '@/core/artifacts';
import {
  generateNativeMediaPreview,
  saveOrOpenNativeFile,
  triggerHaptic,
  type NativeFileAction,
  type NativeFilePreviewResult,
} from '@/core/native-bridge';
import { describeCallError, type RemoteApi } from '@/core/wire-client';
import { CheckIcon, DownloadIcon, ExternalLinkIcon, FileCodeIcon, ShareIcon, XIcon } from './icons';

const AUTO_PREVIEW_PDF_MAX_BYTES = 12 * 1024 * 1024;
const AUTO_PREVIEW_VIDEO_MAX_BYTES = 14 * 1024 * 1024;
const AUDIO_WAVE_BARS = [28, 52, 74, 42, 88, 64, 34, 78, 96, 56, 40, 84, 62, 46, 90, 50, 32, 68];

const nativePreviewCache = new Map<string, Promise<NativeFilePreviewResult | null>>();

function getNativePreview(
  cacheKey: string,
  loaded: LoadedMedia,
  kind: 'pdf' | 'video' | 'audio'
): Promise<NativeFilePreviewResult | null> {
  const existing = nativePreviewCache.get(cacheKey);
  if (existing) return existing;
  const task = (async () => {
    const blob = await resolveBlob(loaded);
    return await generateNativeMediaPreview(blob, loaded.name, loaded.mimeType, kind);
  })();
  nativePreviewCache.set(cacheKey, task);
  task.catch(() => {
    nativePreviewCache.delete(cacheKey);
  });
  return task;
}

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

export function MediaArtifactStrip(props: {
  api: RemoteApi;
  conversationId: string;
  artifacts: readonly MediaArtifact[];
}) {
  const [lightbox, setLightbox] = useState<LoadedMedia | null>(null);
  const [textModal, setTextModal] = useState<LoadedMedia | null>(null);

  if (props.artifacts.length === 0) return null;

  const images = props.artifacts.filter((a) => artifactKind(a) === 'image');
  const others = props.artifacts.filter((a) => artifactKind(a) !== 'image');

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
              onOpenLightbox={(loaded) => {
                triggerHaptic('light');
                setLightbox(loaded);
              }}
            />
          ))}
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="media-file-stack">
          {others.map((item) => {
            const kind = artifactKind(item);
            if (kind === 'video') {
              return (
                <VideoArtifactCard
                  key={item.uri}
                  api={props.api}
                  conversationId={props.conversationId}
                  artifact={item}
                />
              );
            }
            if (kind === 'audio') {
              return (
                <AudioArtifactCard
                  key={item.uri}
                  api={props.api}
                  conversationId={props.conversationId}
                  artifact={item}
                />
              );
            }
            return (
              <FileArtifactCard
                key={item.uri}
                api={props.api}
                conversationId={props.conversationId}
                artifact={item}
                onOpenText={(loaded) => {
                  triggerHaptic('light');
                  setTextModal(loaded);
                }}
              />
            );
          })}
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
                onClick={() => {
                  triggerHaptic('medium');
                  void deliverMedia(lightbox, 'download');
                }}
                aria-label="Telefona indir"
                title="İndirilenler/Sovra klasörüne kaydet"
              >
                <DownloadIcon size={16} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm media-lightbox-btn"
                onClick={() => {
                  triggerHaptic('light');
                  void deliverMedia(lightbox, 'share');
                }}
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
        <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={textModal.name}>
          <div className="sheet-backdrop" onClick={() => setTextModal(null)} />
          <div className="sheet-panel diff-sheet-panel">
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <div className="sheet-title-group">
                <h2 className="sheet-title">{textModal.name}</h2>
                {textModal.size > 0 ? (
                  <p className="sheet-subtitle mono">{formatFileSize(textModal.size)}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="wb-icon-btn sm"
                onClick={() => {
                  triggerHaptic('medium');
                  void deliverMedia(textModal, 'download');
                }}
                aria-label="Telefona indir"
                title="İndirilenler/Sovra klasörüne kaydet"
              >
                <DownloadIcon size={15} />
              </button>
              <button
                type="button"
                className="wb-icon-btn sm"
                onClick={() => {
                  triggerHaptic('light');
                  void deliverMedia(textModal, 'share');
                }}
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
              <pre className="media-text-preview mono">{textModal.textContent ?? ''}</pre>
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
  onOpenLightbox: (loaded: LoadedMedia) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadMediaPreview(props.api, props.conversationId, props.artifact).then(
      (res) => {
        if (active) setLoaded(res);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [props.api, props.conversationId, props.artifact]);

  if (failed) {
    return (
      <div className="media-fallback-pill">
        <FileCodeIcon size={14} />
        <span className="media-fallback-name">{props.artifact.name}</span>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="media-image-skeleton" aria-label={`${props.artifact.name} yükleniyor`}>
        <span className="spinner xs" />
        <span className="media-skeleton-name">{props.artifact.name}</span>
      </div>
    );
  }

  return (
    <div className="media-image-card-wrap">
      <button
        type="button"
        className="media-image-card"
        onClick={() => props.onOpenLightbox(loaded)}
        aria-label={`${loaded.name} görselini büyüt`}
      >
        <img src={loaded.url} alt={loaded.name} className="media-image-el" loading="lazy" />
        <span className="media-image-caption">
          <span className="media-image-caption-name">{loaded.name}</span>
          {loaded.size > 0 ? (
            <span className="media-image-caption-size mono">{formatFileSize(loaded.size)}</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={`media-image-quick-dl${downloaded ? ' is-done' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          triggerHaptic('medium');
          void deliverMedia(loaded, 'download').then((ok) => {
            if (ok) {
              triggerHaptic('success');
              setDownloaded(true);
            }
          });
        }}
        aria-label={`${loaded.name} görselini indir`}
        title="İndir"
      >
        {downloaded ? <CheckIcon size={14} /> : <DownloadIcon size={14} />}
      </button>
    </div>
  );
}

function VideoArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [peek, setPeek] = useState<PeekedMedia | null>(null);
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [preview, setPreview] = useState<NativeFilePreviewResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void peekMediaMetadata(props.api, props.conversationId, props.artifact)
      .then((meta) => {
        if (!active) return;
        setPeek(meta);
        if (meta.size > 0 && meta.size <= AUTO_PREVIEW_VIDEO_MAX_BYTES) {
          void loadMediaPreview(props.api, props.conversationId, props.artifact)
            .then((full) => {
              if (!active) return;
              setLoaded(full);
              void getNativePreview(`${props.conversationId}|${props.artifact.uri}`, full, 'video').then(
                (p) => {
                  if (active && p) setPreview(p);
                }
              );
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [props.api, props.conversationId, props.artifact]);

  async function ensureLoaded(): Promise<LoadedMedia> {
    if (loaded) return loaded;
    const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
    setLoaded(res);
    return res;
  }

  async function handlePlay(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    triggerHaptic('light');
    try {
      await ensureLoaded();
      setPlaying(true);
    } catch (err) {
      setError(describeCallError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    triggerHaptic('medium');
    try {
      const full = await ensureLoaded();
      const ok = await deliverMedia(full, 'download');
      if (ok) {
        triggerHaptic('success');
        setDownloaded(true);
      }
    } catch (err) {
      setError(describeCallError(err));
    } finally {
      setLoading(false);
    }
  }

  const sizeText = formatFileSize(loaded?.size ?? peek?.size ?? 0);
  const durText = formatDuration(preview?.durationMs);

  if (playing && loaded) {
    return (
      <div className="media-video-card">
        <video
          src={loaded.url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="media-video-el"
        />
        <div className="media-video-foot">
          <span className="media-file-name">{loaded.name}</span>
          {sizeText ? <span className="media-file-size mono">{sizeText}</span> : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => void handleDownload()}
            aria-label="Videoyu telefona indir"
            title="İndir"
          >
            {downloaded ? <CheckIcon size={14} className="icon-accent" /> : <DownloadIcon size={14} />}
          </button>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => {
              triggerHaptic('light');
              void deliverMedia(loaded, 'share');
            }}
            aria-label="Videoyu paylaş"
            title="Paylaş"
          >
            <ShareIcon size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="media-rich-card is-video-rich">
      <button
        type="button"
        className="media-video-poster-btn"
        disabled={loading}
        onClick={() => void handlePlay()}
        aria-label={`${props.artifact.name} videosunu oynat`}
      >
        {preview?.thumbnail ? (
          <img src={preview.thumbnail} alt={props.artifact.name} className="media-video-poster-img" />
        ) : loaded ? (
          <video
            src={`${loaded.url}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            className="media-video-poster-img"
          />
        ) : (
          <div className="media-video-poster-placeholder">
            <span className="media-ext-badge is-video">VIDEO</span>
          </div>
        )}
        <span className="media-video-play-orb" aria-hidden="true">
          {loading ? <span className="spinner xs" /> : '▶'}
        </span>
        {durText || sizeText ? (
          <span className="media-corner-pill mono">
            {[durText, sizeText].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </button>
      <div className="media-rich-foot">
        <div className="media-file-info">
          <strong className="media-file-name">{peek?.name ?? props.artifact.name}</strong>
          <span className="media-file-sub">
            {error ?? (loading ? 'Video hazırlanıyor…' : 'Oynatmak için dokun · Telefona indirilebilir')}
          </span>
        </div>
        <button
          type="button"
          className={`media-file-dl-btn${downloaded ? ' is-done' : ''}`}
          disabled={loading}
          onClick={() => void handleDownload()}
          aria-label="Videoyu indir"
          title="İndir"
        >
          {downloaded ? <CheckIcon size={15} /> : <DownloadIcon size={15} />}
        </button>
      </div>
    </div>
  );
}

function AudioArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [peek, setPeek] = useState<PeekedMedia | null>(null);
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [preview, setPreview] = useState<NativeFilePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void peekMediaMetadata(props.api, props.conversationId, props.artifact)
      .then((meta) => {
        if (active) setPeek(meta);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [props.api, props.conversationId, props.artifact]);

  async function ensureLoaded(): Promise<LoadedMedia> {
    if (loaded) return loaded;
    const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
    setLoaded(res);
    void getNativePreview(`${props.conversationId}|${props.artifact.uri}`, res, 'audio').then(
      (p) => {
        if (p) setPreview(p);
      }
    );
    return res;
  }

  async function loadAudio(): Promise<void> {
    if (loading || loaded) return;
    setLoading(true);
    setError(null);
    triggerHaptic('light');
    try {
      await ensureLoaded();
    } catch (err) {
      setError(describeCallError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    triggerHaptic('medium');
    try {
      const full = await ensureLoaded();
      const ok = await deliverMedia(full, 'download');
      if (ok) {
        triggerHaptic('success');
        setDownloaded(true);
      }
    } catch (err) {
      setError(describeCallError(err));
    } finally {
      setLoading(false);
    }
  }

  const sizeText = formatFileSize(loaded?.size ?? peek?.size ?? 0);
  const durText = formatDuration(preview?.durationMs);

  if (loaded) {
    return (
      <div className="media-audio-card">
        <div className="media-audio-head">
          <span className="media-file-name">{loaded.name}</span>
          {durText || sizeText ? (
            <span className="media-file-size mono">
              {[durText, sizeText].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => void handleDownload()}
            aria-label="Sesi indir"
            title="İndir"
          >
            {downloaded ? <CheckIcon size={14} className="icon-accent" /> : <DownloadIcon size={14} />}
          </button>
        </div>
        <audio src={loaded.url} controls className="media-audio-el" />
      </div>
    );
  }

  return (
    <div className="media-file-card-shell">
      <button
        type="button"
        className="media-file-main-btn"
        disabled={loading}
        onClick={() => void loadAudio()}
      >
        <span className="media-ext-badge is-audio">{loading ? '…' : '▶'}</span>
        <span className="media-file-info">
          <strong className="media-file-name">{peek?.name ?? props.artifact.name}</strong>
          <span className="media-audio-wave" aria-hidden="true">
            {AUDIO_WAVE_BARS.map((h, i) => (
              <span key={i} className="media-audio-bar" style={{ height: `${Math.round(h * 0.16)}px` }} />
            ))}
          </span>
          <span className="media-file-sub">
            {error ?? (sizeText ? `Ses dosyası · ${sizeText} · Dinlemek için dokun` : 'Sesi dinlemek için dokun')}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`media-file-dl-btn${downloaded ? ' is-done' : ''}`}
        disabled={loading}
        onClick={() => void handleDownload()}
        aria-label="Sesi indir"
        title="İndir"
      >
        {downloaded ? <CheckIcon size={15} /> : <DownloadIcon size={15} />}
      </button>
    </div>
  );
}

function FileArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
  onOpenText: (loaded: LoadedMedia) => void;
}) {
  const [peek, setPeek] = useState<PeekedMedia | null>(null);
  const [pdfPreview, setPdfPreview] = useState<NativeFilePreviewResult | null>(null);
  const [busyMode, setBusyMode] = useState<'open' | 'download' | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = artifactKind(props.artifact);
  const isPdf = kind === 'pdf';
  const badgeTone = fileBadgeTone(props.artifact.name);

  // WhatsApp/Telegram tarzı: kart ekrana gelince dosya boyutu + içerik/PDF 1. sayfa önizlemesini sessizce hazırla.
  useEffect(() => {
    let active = true;
    void peekMediaMetadata(props.api, props.conversationId, props.artifact)
      .then((meta) => {
        if (!active) return;
        setPeek(meta);
        if (isPdf && meta.size > 0 && meta.size <= AUTO_PREVIEW_PDF_MAX_BYTES) {
          void loadMediaPreview(props.api, props.conversationId, props.artifact)
            .then((full) => {
              if (!active) return;
              void getNativePreview(`${props.conversationId}|${props.artifact.uri}`, full, 'pdf').then(
                (rendered) => {
                  if (active && rendered) setPdfPreview(rendered);
                }
              );
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [props.api, props.conversationId, props.artifact, isPdf]);

  async function handleAction(mode: 'open' | 'download'): Promise<void> {
    if (busyMode) return;
    setBusyMode(mode);
    setError(null);
    triggerHaptic(mode === 'download' ? 'medium' : 'light');
    try {
      const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
      if (mode === 'open' && res.textContent !== undefined) {
        props.onOpenText(res);
      } else {
        const ok = await deliverMedia(res, mode);
        if (ok) {
          triggerHaptic('success');
          setDownloaded(true);
        } else {
          setError('Dosya telefona kaydedilemedi.');
        }
      }
    } catch (err) {
      setError(describeCallError(err));
    } finally {
      setBusyMode(null);
    }
  }

  const sizeText = formatFileSize(peek?.size ?? 0);
  const pageText = pdfPreview?.pageCount ? `${pdfPreview.pageCount} sayfa` : '';
  const metaLine = [
    pageText,
    sizeText,
    fileTypeLabel(props.artifact.name, kind),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`media-rich-card ${badgeTone}`}>
      {/* PDF 1. sayfa canlı önizleme penceresi (Telegram/WhatsApp tarzı) */}
      {isPdf && pdfPreview?.thumbnail ? (
        <button
          type="button"
          className="media-pdf-preview-stage"
          disabled={Boolean(busyMode)}
          onClick={() => void handleAction('open')}
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

      {/* Metin / Markdown / JSON / Kod dosyaları için canlı ilk satırlar önizleme penceresi */}
      {!isPdf && peek?.snippet ? (
        <button
          type="button"
          className="media-snippet-stage"
          disabled={Boolean(busyMode)}
          onClick={() => void handleAction('open')}
          aria-label={`${props.artifact.name} içeriğini aç`}
        >
          <pre className="media-snippet-pre mono">{peek.snippet}</pre>
          <span className="media-snippet-fade" aria-hidden="true" />
        </button>
      ) : null}

      <div className="media-rich-foot">
        <button
          type="button"
          className="media-file-main-btn"
          disabled={Boolean(busyMode)}
          onClick={() => void handleAction('open')}
        >
          <span className={`media-ext-badge ${badgeTone}`}>
            {extensionLabel(props.artifact.name)}
          </span>
          <span className="media-file-info">
            <strong className="media-file-name">{peek?.name ?? props.artifact.name}</strong>
            <span className="media-file-sub">
              {error ??
                (busyMode === 'download'
                  ? 'İndirilenler/Sovra klasörüne indiriliyor…'
                  : busyMode === 'open'
                    ? 'İndiriliyor ve açılıyor…'
                    : downloaded
                      ? `İndirildi${sizeText ? ` · ${sizeText}` : ''} · Açmak için dokun`
                      : metaLine || 'Telefonda açmak ve indirmek için dokun')}
            </span>
          </span>
          <ExternalLinkIcon size={14} className="icon-passive" />
        </button>
        <button
          type="button"
          className={`media-file-dl-btn${downloaded ? ' is-done' : ''}`}
          disabled={Boolean(busyMode)}
          onClick={() => void handleAction('download')}
          aria-label={`${props.artifact.name} dosyasını telefona indir`}
          title="Telefona indir"
        >
          {busyMode === 'download' ? (
            <span className="spinner xs" />
          ) : downloaded ? (
            <CheckIcon size={15} />
          ) : (
            <DownloadIcon size={15} />
          )}
        </button>
      </div>
    </div>
  );
}
