import { useCommands } from '@components/contexts/CommandsContext';
import { GenericFileIcon } from '@components/primitives/icons';
import { defineUnit } from '@core/units';
import { artifactKind, safeArtifactUrl } from '@lib/artifact-references';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js';
import type { ChatMediaGalleryItem } from '@/commands';
import {
  VIDEO_META_H,
  VIDEO_TILE_META_H,
  bindMediaSource,
  createNearViewport,
  createStreamedSource,
  formatBytes,
  formatDuration,
  setVideoAspect,
  singleVideoBox,
  videoAspect,
  videoGalleryLayout,
} from './streamed-media';
import {
  audioMeta,
  audioMetaDetail,
  audioMetaName,
  audioPlayer,
  audioSection,
  compactAction,
  fileList,
  fileName,
  filePillSection,
  galleryMediaImg,
  galleryMediaSection,
  glassActionBtn,
  groupRoot,
  hoverOverlay,
  mediaPlaceholder,
  mediaStrip,
  singleImageEl,
  singleMediaSection,
  videoCard,
  videoFrame,
  videoFrameEl,
  videoFrameOverlay,
  videoFrameOverlayInteractive,
  videoMetaActions,
  videoMetaDetail,
  videoMetaName,
  videoMetaRow,
  videoMetaText,
  videoOverlayPlay,
  videoPlayTrigger,
} from './artifact.css';

export type ArtifactData = TranscriptArtifact & { itemId: string };
export type ArtifactGroupData = { itemId: string; items: TranscriptArtifact[] };
export type ArtifactUnitInput = ArtifactGroupData | ArtifactData;

const SINGLE_IMAGE_MAX_H = 180;
const GALLERY_TILE_W = 144;
const GALLERY_TILE_H = 108;
const GALLERY_GAP = 8;
const AUDIO_ROW_H = 52;
const FILE_PILL_H = 36;
const FILE_LIST_GAP = 6;
const SECTION_GAP = 8;

async function resolveRemotePdf(uri: string, signal: AbortSignal) {
  const response = await fetch(uri, { signal, credentials: 'omit' });
  if (!response.ok || !response.body)
    throw new Error('PDF yüklenemedi. Dosya bağlantısını açabilirsin.');
  const parts: ArrayBuffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024 * 1024) throw new Error('PDF önizleme sınırını aşıyor.');
      const buffer = new ArrayBuffer(value.byteLength);
      new Uint8Array(buffer).set(value);
      parts.push(buffer);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const blob = new Blob(parts, { type: 'application/pdf' });
  if (!(await blob.slice(0, 5).text()).startsWith('%PDF-'))
    throw new Error('Bu bağlantı bir PDF dosyası döndürmedi.');
  const url = URL.createObjectURL(blob);
  return { url, dispose: () => URL.revokeObjectURL(url) };
}

function isVideo(artifact: TranscriptArtifact): boolean {
  return artifactKind(artifact) === 'video';
}

function normalizeArtifactGroup(input: ArtifactUnitInput): ArtifactGroupData {
  if ('uri' in input) {
    return { itemId: input.itemId, items: [input] };
  }
  return input;
}

function partitionArtifacts(items: TranscriptArtifact[]) {
  const media: TranscriptArtifact[] = [];
  const audio: TranscriptArtifact[] = [];
  const files: TranscriptArtifact[] = [];
  for (const item of items) {
    const k = artifactKind(item);
    if (k === 'image' || k === 'video') {
      media.push(item);
    } else if (k === 'audio') {
      audio.push(item);
    } else {
      files.push(item);
    }
  }
  return { media, audio, files };
}

function groupHeight(input: ArtifactUnitInput, width: number): number {
  const group = normalizeArtifactGroup(input);
  const { media, audio, files } = partitionArtifacts(group.items);
  const blocks: number[] = [];

  if (media.length === 1) {
    blocks.push(
      artifactKind(media[0]!) === 'video'
        ? singleVideoBox(width, videoAspect(media[0]!.uri)).height
        : SINGLE_IMAGE_MAX_H
    );
  } else if (media.length >= 2 && media.some(isVideo)) {
    blocks.push(videoGalleryLayout(width, media.length).height);
  } else if (media.length >= 2) {
    const perRow = Math.max(1, Math.floor((width + GALLERY_GAP) / (GALLERY_TILE_W + GALLERY_GAP)));
    const rows = Math.ceil(media.length / perRow);
    blocks.push(rows * GALLERY_TILE_H + Math.max(0, rows - 1) * GALLERY_GAP);
  }

  for (let i = 0; i < audio.length; i += 1) {
    blocks.push(AUDIO_ROW_H);
  }

  if (files.length > 0) {
    blocks.push(files.length * FILE_PILL_H + Math.max(0, files.length - 1) * FILE_LIST_GAP);
  }

  if (blocks.length === 0) return FILE_PILL_H;
  return blocks.reduce((acc, h) => acc + h, 0) + Math.max(0, blocks.length - 1) * SECTION_GAP;
}

function PlayIcon(props: { size?: number }) {
  const s = () => props.size ?? 12;
  return (
    <svg width={s()} height={s()} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.2 2.8a.6.6 0 0 1 .9-.52l8.2 5.2a.6.6 0 0 1 0 1.04l-8.2 5.2a.6.6 0 0 1-.9-.52V2.8Z" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L9 7" />
      <path d="M6.5 13.5H2.5V9.5" />
      <path d="M2.5 13.5L7 9" />
    </svg>
  );
}

function useResolvedArtifact(getArtifact: () => TranscriptArtifact, eager: () => boolean) {
  const commands = useCommands();
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [requested, setRequested] = createSignal(0);
  const [loading, setLoading] = createSignal(false);

  const kind = createMemo(() => artifactKind(getArtifact()));
  const source = createMemo(() => getArtifact().uri);
  const canResolve = () => !!safeArtifactUrl(source()) || !!commands().resolveArtifact;

  createEffect(() => {
    const uri = source();
    const data = untrack(() => getArtifact());
    const resolver = untrack(() => commands().resolveArtifact);
    const shouldAuto = eager();
    if (!shouldAuto && !requested()) return;
    let active = true;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setError(null);
    setLoading(true);
    setUrl(null);
    const direct = safeArtifactUrl(uri);
    const resolve =
      direct && kind() === 'pdf' && /^https?:/i.test(direct)
        ? resolveRemotePdf(direct, controller.signal)
        : direct
          ? Promise.resolve({ url: direct, dispose: undefined })
          : resolver
            ? resolver(data, { signal: controller.signal })
            : Promise.reject(new Error('Önizleme kullanılamıyor.'));
    void resolve
      .then((result) => {
        if (!active) {
          result.dispose?.();
          return;
        }
        release = result.dispose;
        setUrl(result.url);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : 'Önizleme kullanılamıyor.');
        }
      });
    onCleanup(() => {
      active = false;
      controller.abort();
      release?.();
    });
  });

  const openExternal = () => {
    const artifact = getArtifact();
    const classification = commands().classifyLink?.(artifact.uri);
    if (classification?.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: classification.path,
        itemId: '',
        source: 'resource-link',
      });
    } else if (/^https?:\/\//i.test(artifact.uri)) {
      window.open(artifact.uri, '_blank', 'noopener,noreferrer');
    }
  };

  return {
    url,
    error,
    loading,
    canResolve,
    kind,
    requestResolve: () => setRequested((n) => n + 1),
    setMediaError: () =>
      setError('Bu dosya görüntülenemedi. Kaydedebilir veya dosyayı açabilirsin.'),
    openExternal,
  };
}

function openArtifactFile(
  commands: ReturnType<typeof useCommands>,
  artifact: TranscriptArtifact,
  itemId: string
) {
  const classification = commands().classifyLink?.(artifact.uri);
  if (classification?.kind === 'workspace-file') {
    commands().onOpenFile?.({
      path: classification.path,
      itemId,
      source: 'resource-link',
    });
  } else if (/^https?:\/\//i.test(artifact.uri)) {
    window.open(artifact.uri, '_blank', 'noopener,noreferrer');
  }
}

/** Lightbox: streamed items carry no URL; the host mints its own for the viewer. */
function openMediaLightbox(
  commands: ReturnType<typeof useCommands>,
  props: {
    artifact: TranscriptArtifact;
    itemId: string;
    index: number;
    mediaList: TranscriptArtifact[];
  },
  currentSrc: string | undefined
) {
  const gallery: ChatMediaGalleryItem[] = props.mediaList.map((item, idx) => ({
    id: item.uri,
    src: idx === props.index ? currentSrc : (safeArtifactUrl(item.uri) ?? undefined),
    alt: item.name,
    kind: artifactKind(item) === 'video' ? 'video' : 'image',
    mimeType: item.mimeType,
    artifact: item,
  }));
  commands().onViewImage?.({
    attachment: {
      id: props.artifact.uri,
      name: props.artifact.name,
      dataUrl: currentSrc,
      mimeType: props.artifact.mimeType,
    },
    itemId: props.itemId,
    source: 'assistant-output',
    kind: artifactKind(props.artifact) === 'video' ? 'video' : 'image',
    gallery,
    index: props.index,
  });
}

/** "Kaydet": the host streams a copy; without it, direct URLs keep a download link. */
function SaveAction(props: {
  artifact: TranscriptArtifact;
  directUrl: () => string | undefined;
  class: string;
}) {
  const commands = useCommands();
  const [saving, setSaving] = createSignal(false);
  const hostSave = () =>
    props.artifact.uri.startsWith('data:') ? undefined : commands().saveArtifact;
  return (
    <Show
      when={hostSave()}
      fallback={
        <Show when={props.directUrl()}>
          {(href) => (
            <a class={props.class} href={href()} download={props.artifact.name}>
              Kaydet
            </a>
          )}
        </Show>
      }
    >
      {(save) => (
        <button
          type="button"
          class={props.class}
          disabled={saving()}
          onClick={(event) => {
            event.stopPropagation();
            setSaving(true);
            void save()(props.artifact)
              .catch(() => undefined)
              .finally(() => setSaving(false));
          }}
        >
          {saving() ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      )}
    </Show>
  );
}

function MediaItemView(props: {
  artifact: TranscriptArtifact;
  itemId: string;
  single: boolean;
  index: number;
  mediaList: TranscriptArtifact[];
  /** In a gallery with videos, image tiles match the video tile size. */
  box?: { width: number; height: number };
}) {
  const commands = useCommands();
  const state = useResolvedArtifact(
    () => props.artifact,
    () => true
  );

  const openLightbox = (resolvedSrc?: string) =>
    openMediaLightbox(commands, props, resolvedSrc ?? state.url() ?? undefined);

  return (
    <section
      class={props.single ? singleMediaSection : galleryMediaSection}
      aria-label={`Output: ${props.artifact.name}`}
      style={{
        ...(state.url() ? { cursor: 'zoom-in' } : {}),
        ...(props.box ? { width: `${props.box.width}px`, height: `${props.box.height}px` } : {}),
      }}
      onClick={() => {
        if (state.url()) openLightbox(state.url()!);
      }}
    >
      <div class={hoverOverlay} onClick={(e) => e.stopPropagation()}>
        <SaveAction
          artifact={props.artifact}
          directUrl={() => state.url() ?? undefined}
          class={glassActionBtn}
        />
        <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
          <button
            type="button"
            class={glassActionBtn}
            onClick={() => commands().onShareArtifact?.(props.artifact)}
          >
            Paylaş
          </button>
        </Show>
        <Show when={!props.artifact.uri.startsWith('data:')}>
          <button
            type="button"
            class={glassActionBtn}
            onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
          >
            Aç
          </button>
        </Show>
      </div>

      <Show
        when={!state.error()}
        fallback={
          <div class={mediaPlaceholder} role="alert">
            {state.error()}
          </div>
        }
      >
        <Show
          when={state.url()}
          fallback={
            <div class={mediaPlaceholder}>
              <span>{state.loading() ? 'Yükleniyor…' : props.artifact.name}</span>
            </div>
          }
        >
          {(src) => (
            <img
              src={src()}
              alt={props.artifact.name}
              onError={state.setMediaError}
              class={props.single ? singleImageEl : galleryMediaImg}
              onClick={(e) => {
                e.stopPropagation();
                openLightbox(src());
              }}
            />
          )}
        </Show>
      </Show>
    </section>
  );
}

/**
 * Video output: the card shows the player (first frame + controls) right away, with no preview
 * step. The source is attached only while the card is near the viewport and `preload="metadata"`
 * never downloads the whole file. Hosts without `mediaUrlForArtifact` keep the "Önizle" flow.
 */
function VideoItemView(props: {
  artifact: TranscriptArtifact;
  itemId: string;
  single: boolean;
  index: number;
  mediaList: TranscriptArtifact[];
  width: Accessor<number>;
}) {
  const commands = useCommands();
  const [section, setSection] = createSignal<HTMLElement>();
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  const [playing, setPlaying] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [duration, setDuration] = createSignal<number>();
  const [mediaError, setMediaError] = createSignal<string>();

  const streamable = () =>
    !!safeArtifactUrl(props.artifact.uri) || !!commands().mediaUrlForArtifact;
  const near = createNearViewport(section);
  const source = createStreamedSource(
    () => props.artifact,
    () => streamable() && (near() || playing())
  );
  // Hosts without streaming: the file loads (into memory) only after "Önizle".
  const legacy = useResolvedArtifact(
    () => props.artifact,
    () => false
  );
  const url = () => (streamable() ? source.url() : (legacy.url() ?? undefined));
  const playableUrl = () => {
    const value = url();
    // The `#t` fragment makes the first frame decode; it is never sent with the request.
    return value && !value.includes('#') && !value.startsWith('data:') ? `${value}#t=0.001` : value;
  };
  bindMediaSource(video, playableUrl);
  createEffect(() => {
    url();
    setReady(false);
  });

  const error = () =>
    mediaError() ?? (streamable() ? source.error() : (legacy.error() ?? undefined));
  const box = createMemo(() =>
    props.single
      ? singleVideoBox(props.width(), videoAspect(props.artifact.uri))
      : (() => {
          const layout = videoGalleryLayout(props.width(), props.mediaList.length);
          return { cardW: layout.tileW, frameH: layout.frameH, height: layout.tileH };
        })()
  );
  const detail = () =>
    [formatBytes(source.size()), formatDuration(duration())].filter(Boolean).join(' · ');
  const directUrl = () => (source.hostStreamed() ? undefined : url());

  const openLightbox = () => {
    video()?.pause();
    openMediaLightbox(commands, props, directUrl());
  };

  return (
    <section
      ref={setSection}
      class={videoCard}
      aria-label={`Output: ${props.artifact.name}`}
      style={{ width: `${box().cardW}px`, height: `${box().height}px` }}
    >
      <div class={videoFrame} style={{ height: `${box().frameH}px` }}>
        <video
          ref={setVideo}
          class={videoFrameEl}
          controls={!!url() && !error()}
          controlslist="nodownload noremoteplayback"
          disableremoteplayback
          playsinline
          preload="metadata"
          aria-label={props.artifact.name}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setDuration(element.duration);
            setVideoAspect(props.artifact.uri, element.videoWidth, element.videoHeight);
            if (element.videoWidth > 0) setReady(true);
          }}
          onLoadedData={() => setReady(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={(event) => {
            if (!event.currentTarget.getAttribute('src')) return;
            setPlaying(false);
            if (source.hostStreamed() && source.retry()) return;
            if (source.fallback()) return;
            setMediaError('Bu video oynatılamadı. Kaydedebilir veya dosyayı açabilirsin.');
          }}
        />
        <Show when={!ready() || error()}>
          <div
            class={`${videoFrameOverlay} ${!streamable() && !legacy.url() ? videoFrameOverlayInteractive : ''}`}
            role={error() ? 'alert' : undefined}
          >
            <Show when={!error()} fallback={<span>{error()}</span>}>
              <Show
                when={streamable() || legacy.url()}
                fallback={
                  <Show
                    when={!legacy.loading() && legacy.canResolve()}
                    fallback={<span>{legacy.loading() ? 'Yükleniyor…' : props.artifact.name}</span>}
                  >
                    <button type="button" class={videoPlayTrigger} onClick={legacy.requestResolve}>
                      Önizle
                    </button>
                  </Show>
                }
              >
                <span class={videoOverlayPlay}>
                  <PlayIcon size={16} />
                </span>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
      <div
        class={videoMetaRow}
        style={{ height: `${props.single ? VIDEO_META_H : VIDEO_TILE_META_H}px` }}
      >
        <span class={videoMetaText} title={props.artifact.name}>
          <span class={videoMetaName}>{props.artifact.name}</span>
          <Show when={detail()}>
            <span class={videoMetaDetail}>{detail()}</span>
          </Show>
        </span>
        <span class={videoMetaActions}>
          <Show when={commands().onViewImage}>
            <button
              type="button"
              class={compactAction}
              aria-label={`Videoyu büyüt: ${props.artifact.name}`}
              title="Büyüt"
              onClick={openLightbox}
            >
              <ExpandIcon />
            </button>
          </Show>
          <Show when={props.single}>
            <SaveAction artifact={props.artifact} directUrl={directUrl} class={compactAction} />
            <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
              <button
                type="button"
                class={compactAction}
                onClick={() => commands().onShareArtifact?.(props.artifact)}
              >
                Paylaş
              </button>
            </Show>
            <Show when={!props.artifact.uri.startsWith('data:')}>
              <button
                type="button"
                class={compactAction}
                onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
              >
                Aç
              </button>
            </Show>
          </Show>
        </span>
      </div>
      <Show when={!props.single}>
        <div class={hoverOverlay}>
          <SaveAction artifact={props.artifact} directUrl={directUrl} class={glassActionBtn} />
          <Show when={!props.artifact.uri.startsWith('data:')}>
            <button
              type="button"
              class={glassActionBtn}
              onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
            >
              Aç
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** Streamed audio row: name, size and duration with an inline player. */
function StreamedAudioRow(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  const [section, setSection] = createSignal<HTMLElement>();
  const [audio, setAudio] = createSignal<HTMLAudioElement>();
  const [playing, setPlaying] = createSignal(false);
  const [duration, setDuration] = createSignal<number>();
  const [mediaError, setMediaError] = createSignal<string>();
  const near = createNearViewport(section);
  const source = createStreamedSource(
    () => props.artifact,
    () => near() || playing()
  );
  bindMediaSource(audio, source.url);
  const detail = () =>
    mediaError() ??
    source.error() ??
    [formatBytes(source.size()), formatDuration(duration())].filter(Boolean).join(' · ');
  const directUrl = () => (source.hostStreamed() ? undefined : source.url());

  return (
    <section ref={setSection} class={audioSection} aria-label={`Output: ${props.artifact.name}`}>
      <span class={audioMeta} title={props.artifact.name}>
        <span class={audioMetaName}>{props.artifact.name}</span>
        <Show when={detail()}>
          <span class={audioMetaDetail}>{detail()}</span>
        </Show>
      </span>
      <audio
        ref={setAudio}
        class={audioPlayer}
        controls
        controlslist="nodownload noremoteplayback"
        preload="metadata"
        aria-label={props.artifact.name}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={(event) => {
          if (!event.currentTarget.getAttribute('src')) return;
          setPlaying(false);
          if (source.hostStreamed() && source.retry()) return;
          if (source.fallback()) return;
          setMediaError('Ses oynatılamadı.');
        }}
      />
      <SaveAction artifact={props.artifact} directUrl={directUrl} class={compactAction} />
      <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
        <button
          type="button"
          class={compactAction}
          onClick={() => commands().onShareArtifact?.(props.artifact)}
        >
          Paylaş
        </button>
      </Show>
      <Show when={!props.artifact.uri.startsWith('data:')}>
        <button
          type="button"
          class={compactAction}
          onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
        >
          Aç
        </button>
      </Show>
    </section>
  );
}

function AudioItemView(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  return (
    <Show
      when={commands().mediaUrlForArtifact || safeArtifactUrl(props.artifact.uri)}
      fallback={<LegacyAudioItemView artifact={props.artifact} itemId={props.itemId} />}
    >
      <StreamedAudioRow artifact={props.artifact} itemId={props.itemId} />
    </Show>
  );
}

function LegacyAudioItemView(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  const state = useResolvedArtifact(
    () => props.artifact,
    () => false
  );

  return (
    <section class={audioSection} aria-label={`Output: ${props.artifact.name}`}>
      <Show
        when={state.url()}
        fallback={
          <>
            <span class={fileName}>{props.artifact.name}</span>
            <Show when={!state.loading() && state.canResolve()}>
              <button type="button" class={compactAction} onClick={state.requestResolve}>
                Önizle
              </button>
            </Show>
          </>
        }
      >
        {(src) => (
          <>
            <audio
              src={src()}
              controls
              preload="metadata"
              onError={state.setMediaError}
              class={audioPlayer}
            />
            <a class={compactAction} href={src()} download={props.artifact.name}>
              Kaydet
            </a>
          </>
        )}
      </Show>
      <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
        <button
          type="button"
          class={compactAction}
          onClick={() => commands().onShareArtifact?.(props.artifact)}
        >
          Paylaş
        </button>
      </Show>
      <Show when={!props.artifact.uri.startsWith('data:')}>
        <button
          type="button"
          class={compactAction}
          onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
        >
          Aç
        </button>
      </Show>
    </section>
  );
}

function FileItemView(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  const state = useResolvedArtifact(
    () => props.artifact,
    () => !!safeArtifactUrl(props.artifact.uri)
  );
  // Streamable outputs such as PDFs are saved by the host directly: no load-into-memory step and
  // no size limit.
  const hostSaves = () =>
    !!commands().saveArtifact &&
    !props.artifact.uri.startsWith('data:') &&
    !safeArtifactUrl(props.artifact.uri) &&
    artifactKind(props.artifact) !== 'file';

  return (
    <section class={filePillSection} aria-label={`Output: ${props.artifact.name}`}>
      <GenericFileIcon />
      <span
        class={fileName}
        title={props.artifact.uri.startsWith('data:') ? undefined : props.artifact.uri}
      >
        {state.error() ? `${props.artifact.name} · ${state.error()}` : props.artifact.name}
      </span>
      <Show
        when={hostSaves()}
        fallback={
          <>
            <Show when={!state.url() && !state.loading() && state.canResolve()}>
              <button type="button" class={compactAction} onClick={state.requestResolve}>
                Kaydetmek için yükle
              </button>
            </Show>
            <Show when={state.url()}>
              {(src) => (
                <a class={compactAction} href={src()} download={props.artifact.name}>
                  Kaydet
                </a>
              )}
            </Show>
          </>
        }
      >
        <SaveAction artifact={props.artifact} directUrl={() => undefined} class={compactAction} />
      </Show>
      <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
        <button
          type="button"
          class={compactAction}
          onClick={() => commands().onShareArtifact?.(props.artifact)}
        >
          Paylaş
        </button>
      </Show>
      <Show when={!props.artifact.uri.startsWith('data:')}>
        <button
          type="button"
          class={compactAction}
          onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
        >
          Dosyayı aç
        </button>
      </Show>
    </section>
  );
}

function ArtifactGroup(props: { data: ArtifactUnitInput; width: Accessor<number> }) {
  const group = createMemo(() => normalizeArtifactGroup(props.data));
  const partitioned = createMemo(() => partitionArtifacts(group().items));
  const hasVideo = createMemo(() => partitioned().media.some(isVideo));
  const tileBox = createMemo(() => {
    const layout = videoGalleryLayout(props.width(), partitioned().media.length);
    return { width: layout.tileW, height: layout.tileH };
  });

  return (
    <div class={groupRoot}>
      <Show when={partitioned().media.length > 0}>
        <div class={mediaStrip}>
          <For each={partitioned().media}>
            {(artifact, index) => (
              <Show
                when={isVideo(artifact)}
                fallback={
                  <MediaItemView
                    artifact={artifact}
                    itemId={group().itemId}
                    single={partitioned().media.length === 1}
                    index={index()}
                    mediaList={partitioned().media}
                    box={hasVideo() && partitioned().media.length > 1 ? tileBox() : undefined}
                  />
                }
              >
                <VideoItemView
                  artifact={artifact}
                  itemId={group().itemId}
                  single={partitioned().media.length === 1}
                  index={index()}
                  mediaList={partitioned().media}
                  width={props.width}
                />
              </Show>
            )}
          </For>
        </div>
      </Show>
      <For each={partitioned().audio}>
        {(artifact) => <AudioItemView artifact={artifact} itemId={group().itemId} />}
      </For>
      <Show when={partitioned().files.length > 0}>
        <div class={fileList}>
          <For each={partitioned().files}>
            {(artifact) => <FileItemView artifact={artifact} itemId={group().itemId} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

export const artifactUnitDef = defineUnit<ArtifactUnitInput, Record<string, never>>({
  kind: 'artifact',
  margin: { top: 6, bottom: 6 },
  vars: {},
  measure: (data, ctx) => groupHeight(data, ctx.width),
  Render: (props) => (
    <ArtifactGroup data={props.data} width={() => props.ctx.measureCtx?.()?.width ?? 560} />
  ),
});
