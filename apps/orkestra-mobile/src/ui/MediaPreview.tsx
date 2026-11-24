import { useEffect, useState } from 'react';
import {
  artifactKind,
  formatFileSize,
  loadMediaPreview,
  type LoadedMedia,
  type MediaArtifact,
} from '@/core/artifacts';
import {
  saveOrOpenNativeFile,
  triggerHaptic,
  type NativeFileAction,
} from '@/core/native-bridge';
import { describeCallError, type RemoteApi } from '@/core/wire-client';
import { CheckIcon, DownloadIcon, ExternalLinkIcon, FileCodeIcon, ShareIcon, XIcon } from './icons';

function extensionLabel(name: string): string {
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  return (ext || 'DOSYA').slice(0, 6).toUpperCase();
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
  );
}

function VideoArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadVideo(): Promise<void> {
    if (loading || loaded) return;
    setLoading(true);
    setError(null);
    triggerHaptic('light');
    try {
      const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
      setLoaded(res);
    } catch {
      setError('Video yüklenemedi (masaüstü sürümü veya dosya yolu kontrol edilmeli).');
    } finally {
      setLoading(false);
    }
  }

  if (loaded) {
    return (
      <div className="media-video-card">
        <video
          src={loaded.url}
          controls
          playsInline
          preload="metadata"
          className="media-video-el"
        />
        <div className="media-video-foot">
          <span className="media-file-name">{loaded.name}</span>
          {loaded.size > 0 ? (
            <span className="media-file-size mono">{formatFileSize(loaded.size)}</span>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => {
              triggerHaptic('medium');
              void deliverMedia(loaded, 'download');
            }}
            aria-label="Videoyu telefona indir"
            title="İndir"
          >
            <DownloadIcon size={14} />
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
    <button
      type="button"
      className="media-file-card is-video"
      disabled={loading}
      onClick={() => void loadVideo()}
    >
      <span className="media-ext-badge is-video">{loading ? '…' : '▶'}</span>
      <span className="media-file-info">
        <strong className="media-file-name">{props.artifact.name}</strong>
        <span className="media-file-sub">
          {error ?? (loading ? 'Video indiriliyor…' : 'Videoyu yüklemek ve oynatmak için dokun')}
        </span>
      </span>
    </button>
  );
}

function AudioArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
}) {
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAudio(): Promise<void> {
    if (loading || loaded) return;
    setLoading(true);
    setError(null);
    try {
      const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
      setLoaded(res);
    } catch {
      setError('Ses dosyası yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }

  if (loaded) {
    return (
      <div className="media-audio-card">
        <div className="media-audio-head">
          <span className="media-file-name">{loaded.name}</span>
          {loaded.size > 0 ? (
            <span className="media-file-size mono">{formatFileSize(loaded.size)}</span>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={() => {
              triggerHaptic('medium');
              void deliverMedia(loaded, 'download');
            }}
            aria-label="Sesi indir"
            title="İndir"
          >
            <DownloadIcon size={14} />
          </button>
        </div>
        <audio src={loaded.url} controls className="media-audio-el" />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="media-file-card"
      disabled={loading}
      onClick={() => void loadAudio()}
    >
      <span className="media-ext-badge is-audio">SES</span>
      <span className="media-file-info">
        <strong className="media-file-name">{props.artifact.name}</strong>
        <span className="media-file-sub">
          {error ?? (loading ? 'Ses indiriliyor…' : 'Sesi dinlemek için dokun')}
        </span>
      </span>
    </button>
  );
}

function FileArtifactCard(props: {
  api: RemoteApi;
  conversationId: string;
  artifact: MediaArtifact;
  onOpenText: (loaded: LoadedMedia) => void;
}) {
  const [busyMode, setBusyMode] = useState<'open' | 'download' | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = artifactKind(props.artifact);
  const isPdf = kind === 'pdf';

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

  return (
    <div className={`media-file-card-shell${isPdf ? ' is-pdf' : ''}`}>
      <button
        type="button"
        className="media-file-main-btn"
        disabled={Boolean(busyMode)}
        onClick={() => void handleAction('open')}
      >
        <span className={`media-ext-badge${isPdf ? ' is-pdf' : ''}`}>
          {extensionLabel(props.artifact.name)}
        </span>
        <span className="media-file-info">
          <strong className="media-file-name">{props.artifact.name}</strong>
          <span className="media-file-sub">
            {error ??
              (busyMode === 'download'
                ? 'Telefona indiriliyor…'
                : busyMode === 'open'
                  ? 'İndiriliyor ve açılıyor…'
                  : downloaded
                    ? 'İndirilenler/Sovra klasörüne kaydedildi · Açmak için dokun'
                    : isPdf
                      ? 'Telefonda açmak ve indirmek için dokun'
                      : 'Önizlemek veya açmak için dokun')}
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
  );
}
