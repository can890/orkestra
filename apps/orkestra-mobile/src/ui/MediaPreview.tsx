import { useEffect, useState } from 'react';
import {
  artifactKind,
  formatFileSize,
  loadMediaPreview,
  type LoadedMedia,
  type MediaArtifact,
} from '@/core/artifacts';
import { triggerHaptic } from '@/core/native-bridge';
import type { RemoteApi } from '@/core/wire-client';
import { ExternalLinkIcon, FileCodeIcon, ShareIcon, XIcon } from './icons';

function extensionLabel(name: string): string {
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  return (ext || 'DOSYA').slice(0, 6).toUpperCase();
}

async function shareOrDownloadMedia(media: LoadedMedia): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      const resp = await fetch(media.url);
      const blob = await resp.blob();
      const file = new File([blob], media.name, { type: media.mimeType });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: media.name, files: [file] });
        return;
      }
    }
  } catch {
    // İptal edildiyse veya dosya paylaşımı desteklenmiyorsa indirmeye düş.
  }
  const a = document.createElement('a');
  a.href = media.url;
  a.download = media.name;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
                onClick={() => void shareOrDownloadMedia(lightbox)}
                aria-label="Paylaş veya kaydet"
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
                onClick={() => void shareOrDownloadMedia(textModal)}
                aria-label="Paylaş veya indir"
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
            onClick={() => void shareOrDownloadMedia(loaded)}
            aria-label="Videoyu paylaş veya kaydet"
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openFile(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    triggerHaptic('light');
    try {
      const res = await loadMediaPreview(props.api, props.conversationId, props.artifact);
      if (res.textContent !== undefined) {
        props.onOpenText(res);
      } else {
        await shareOrDownloadMedia(res);
      }
    } catch {
      setError('Dosya önizlenemedi.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      className="media-file-card"
      disabled={loading}
      onClick={() => void openFile()}
    >
      <span className="media-ext-badge">{extensionLabel(props.artifact.name)}</span>
      <span className="media-file-info">
        <strong className="media-file-name">{props.artifact.name}</strong>
        <span className="media-file-sub">
          {error ?? (loading ? 'Dosya yükleniyor…' : 'Önizlemek veya paylaşmak için dokun')}
        </span>
      </span>
      <ExternalLinkIcon size={14} className="icon-passive" />
    </button>
  );
}
