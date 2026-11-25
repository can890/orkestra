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
  AlertIcon,
  DownloadIcon,
  ExpandIcon,
  OpenIcon,
  PauseIcon,
  PlayIcon,
  ShareIcon,
  VideoScrubber,
  VolumeIcon,
  WaveScrubber,
  createPlayback,
  extensionLabel,
  formatClock,
} from './media-controls';
import {
  AUDIO_ROW_H,
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
  audioPlayer,
  audioSection,
  compactAction,
  fileList,
  fileName,
  filePillSection,
  galleryMediaImg,
  galleryMediaSection,
  groupRoot,
  hoverOverlay,
  mediaPlaceholder,
  mediaStrip,
  singleImageEl,
  singleMediaSection,
} from './artifact.css';
import {
  actions,
  audioBody,
  audioCard,
  audioDetail,
  audioName,
  audioPlay,
  audioTime,
  audioTitleRow,
  audioWaveRow,
  bigPlay,
  controlBar,
  controlBtn,
  controlRow,
  controlSpacer,
  controlTime,
  controlTimeTotal,
  durationChip,
  floatingActions,
  footer,
  footerDetail,
  footerName,
  footerText,
  frame,
  glassIconAction,
  glassPill,
  iconAction,
  placeholder,
  placeholderIcon,
  spinner,
  videoCard,
  videoEl,
} from './media-player.css';

export type ArtifactData = TranscriptArtifact & { itemId: string };
export type ArtifactGroupData = { itemId: string; items: TranscriptArtifact[] };
export type ArtifactUnitInput = ArtifactGroupData | ArtifactData;

const SINGLE_IMAGE_MAX_H = 180;
const GALLERY_TILE_W = 144;
const GALLERY_TILE_H = 108;
const GALLERY_GAP = 8;
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
  /** Icon-only button (the label moves to the tooltip). */
  icon?: boolean;
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
            <a
              class={props.class}
              href={href()}
              download={props.artifact.name}
              title={props.icon ? 'Kaydet' : undefined}
              aria-label={props.icon ? `Kaydet: ${props.artifact.name}` : undefined}
            >
              {props.icon ? <DownloadIcon /> : 'Kaydet'}
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
          title={props.icon ? (saving() ? 'Kaydediliyor…' : 'Kaydet') : undefined}
          aria-label={props.icon ? `Kaydet: ${props.artifact.name}` : undefined}
          onClick={(event) => {
            event.stopPropagation();
            setSaving(true);
            void save()(props.artifact)
              .catch(() => undefined)
              .finally(() => setSaving(false));
          }}
        >
          {props.icon ? <DownloadIcon /> : saving() ? 'Kaydediliyor…' : 'Kaydet'}
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
          class={glassIconAction}
          icon
        />
        <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
          <button
            type="button"
            class={glassIconAction}
            aria-label="Paylaş"
            title="Paylaş"
            onClick={() => commands().onShareArtifact?.(props.artifact)}
          >
            <ShareIcon size={15} />
          </button>
        </Show>
        <Show when={!props.artifact.uri.startsWith('data:')}>
          <button
            type="button"
            class={glassIconAction}
            aria-label="Dosyayı aç"
            title="Dosyayı aç"
            onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
          >
            <OpenIcon size={15} />
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
 * Video output: a poster frame with our own player (large play button, a control bar that slides
 * in while playing, keyboard shortcuts) instead of the browser's native controls. The source is
 * attached only while the card is near the viewport and `preload="metadata"` never downloads the
 * whole file. Hosts without `mediaUrlForArtifact` keep the "Önizle" step.
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
  const [frameEl, setFrameEl] = createSignal<HTMLDivElement>();
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  const [ready, setReady] = createSignal(false);
  const [mediaError, setMediaError] = createSignal<string>();
  const [pointerActive, setPointerActive] = createSignal(false);
  const [scrubbing, setScrubbing] = createSignal(false);
  const playback = createPlayback(video, { poster: true });

  const streamable = () =>
    !!safeArtifactUrl(props.artifact.uri) || !!commands().mediaUrlForArtifact;
  const near = createNearViewport(section);
  const source = createStreamedSource(
    () => props.artifact,
    () => streamable() && (near() || playback.playing())
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
  // Small frames (gallery tiles, very wide videos) get the reduced control set.
  const tight = () => !props.single || box().frameH < 150;
  const detail = () =>
    [
      props.single ? extensionLabel(props.artifact.name) : undefined,
      formatBytes(source.size()),
      formatDuration(playback.duration()),
    ]
      .filter(Boolean)
      .join(' · ');
  const directUrl = () => (source.hostStreamed() ? undefined : url());
  const playable = () => !!url() && !error();

  // The control bar shows while paused, and while the pointer moves over a playing video.
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    setPointerActive(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setPointerActive(false), 2200);
  };
  const rest = () => {
    clearTimeout(hideTimer);
    setPointerActive(false);
  };
  onCleanup(() => clearTimeout(hideTimer));
  const barVisible = () =>
    playable() && playback.started() && (!playback.playing() || pointerActive() || scrubbing());
  const showBigPlay = () =>
    !error() &&
    (streamable() || !!legacy.url()) &&
    !playback.playing() &&
    !scrubbing() &&
    !(tight() && playback.started());

  const expand = () => {
    if (commands().onViewImage) {
      playback.pause();
      openMediaLightbox(commands, props, directUrl());
      return;
    }
    const element = frameEl();
    if (!element) return;
    if (document.fullscreenElement === element) void document.exitFullscreen();
    else void element.requestFullscreen?.().catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!playable() || event.metaKey || event.ctrlKey || event.altKey) return;
    const onFrame = event.target === event.currentTarget;
    const key = event.key.toLowerCase();
    if ((key === ' ' || key === 'k') && onFrame) playback.toggle();
    else if (key === 'arrowleft') playback.seekBy(-5);
    else if (key === 'arrowright') playback.seekBy(5);
    else if (key === 'm') playback.toggleMute();
    else if (key === 'f') expand();
    else return;
    event.preventDefault();
    event.stopPropagation();
    poke();
  };
  const stop = (event: Event) => event.stopPropagation();

  return (
    <section
      ref={setSection}
      class={videoCard}
      aria-label={`Output: ${props.artifact.name}`}
      style={{ width: `${box().cardW}px`, height: `${box().height}px` }}
    >
      <div
        ref={setFrameEl}
        class={frame}
        style={{ height: `${box().frameH}px` }}
        tabindex={playable() ? 0 : -1}
        data-idle={playback.playing() && !barVisible()}
        onClick={() => {
          if (playable()) playback.toggle();
        }}
        onDblClick={() => {
          if (playable()) expand();
        }}
        onPointerMove={poke}
        onPointerLeave={rest}
        onKeyDown={onKeyDown}
      >
        <video
          ref={setVideo}
          class={videoEl}
          disableremoteplayback
          playsinline
          preload="metadata"
          aria-label={props.artifact.name}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setVideoAspect(props.artifact.uri, element.videoWidth, element.videoHeight);
            if (element.videoWidth > 0) setReady(true);
          }}
          onLoadedData={() => setReady(true)}
          onError={(event) => {
            if (!event.currentTarget.getAttribute('src')) return;
            if (source.hostStreamed() && source.retry()) return;
            if (source.fallback()) return;
            setMediaError('Bu video oynatılamadı. Kaydedebilir veya dosyayı açabilirsin.');
          }}
        />
        <Show when={!ready() || error()}>
          <div class={placeholder} role={error() ? 'alert' : undefined}>
            <Show
              when={!error()}
              fallback={
                <>
                  <span class={placeholderIcon}>
                    <AlertIcon size={18} />
                  </span>
                  <span>{error()}</span>
                </>
              }
            >
              <Show when={!streamable() && !legacy.url()}>
                <Show
                  when={!legacy.loading() && legacy.canResolve()}
                  fallback={<span>{legacy.loading() ? 'Yükleniyor…' : props.artifact.name}</span>}
                >
                  <button
                    type="button"
                    class={glassPill}
                    onClick={(event) => {
                      event.stopPropagation();
                      legacy.requestResolve();
                    }}
                  >
                    <PlayIcon size={12} />
                    Önizle
                  </button>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
        <Show when={showBigPlay()}>
          <button
            type="button"
            class={bigPlay}
            data-compact={tight()}
            tabindex={-1}
            aria-label={`Oynat: ${props.artifact.name}`}
            onClick={(event) => {
              event.stopPropagation();
              if (playable()) playback.toggle();
            }}
          >
            <PlayIcon size={tight() ? 17 : 22} />
          </button>
        </Show>
        <Show when={playback.playing() && playback.waiting()}>
          <span class={spinner} />
        </Show>
        <Show when={ready() && !error() && !playback.started() && playback.duration()}>
          <span class={durationChip}>{formatDuration(playback.duration())}</span>
        </Show>
        <div class={controlBar} data-visible={barVisible()} onClick={stop} onDblClick={stop}>
          <VideoScrubber playback={playback} label="Video konumu" onActiveChange={setScrubbing} />
          <div class={controlRow}>
            <button
              type="button"
              class={controlBtn}
              tabindex={barVisible() ? 0 : -1}
              aria-label={playback.playing() ? 'Duraklat' : 'Oynat'}
              title={playback.playing() ? 'Duraklat' : 'Oynat'}
              onClick={playback.toggle}
            >
              {playback.playing() ? <PauseIcon /> : <PlayIcon />}
            </button>
            <span class={controlTime}>
              {formatClock(playback.current())}
              <Show when={!tight() && playback.duration()}>
                <span class={controlTimeTotal}> / {formatDuration(playback.duration())}</span>
              </Show>
            </span>
            <span class={controlSpacer} />
            <button
              type="button"
              class={controlBtn}
              tabindex={barVisible() ? 0 : -1}
              aria-label={playback.muted() ? 'Sesi aç' : 'Sesi kapat'}
              title={playback.muted() ? 'Sesi aç' : 'Sesi kapat'}
              onClick={playback.toggleMute}
            >
              <VolumeIcon muted={playback.muted()} />
            </button>
            <button
              type="button"
              class={controlBtn}
              tabindex={barVisible() ? 0 : -1}
              aria-label={`Videoyu büyüt: ${props.artifact.name}`}
              title="Büyüt"
              onClick={expand}
            >
              <ExpandIcon />
            </button>
          </div>
        </div>
      </div>
      <div
        class={footer}
        data-compact={!props.single}
        style={{ height: `${props.single ? VIDEO_META_H : VIDEO_TILE_META_H}px` }}
      >
        <span class={footerText} title={props.artifact.name}>
          <span class={footerName}>{props.artifact.name}</span>
          <Show when={detail()}>
            <span class={footerDetail}>{detail()}</span>
          </Show>
        </span>
        <Show when={props.single}>
          <span class={actions}>
            <button
              type="button"
              class={iconAction}
              aria-label={`Videoyu büyüt: ${props.artifact.name}`}
              title="Büyüt"
              onClick={expand}
            >
              <ExpandIcon />
            </button>
            <SaveAction artifact={props.artifact} directUrl={directUrl} class={iconAction} icon />
            <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
              <button
                type="button"
                class={iconAction}
                aria-label="Paylaş"
                title="Paylaş"
                onClick={() => commands().onShareArtifact?.(props.artifact)}
              >
                <ShareIcon />
              </button>
            </Show>
            <Show when={!props.artifact.uri.startsWith('data:')}>
              <button
                type="button"
                class={iconAction}
                aria-label="Dosyayı aç"
                title="Dosyayı aç"
                onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
              >
                <OpenIcon />
              </button>
            </Show>
          </span>
        </Show>
      </div>
      <Show when={!props.single}>
        <div class={floatingActions}>
          <button
            type="button"
            class={glassIconAction}
            aria-label={`Videoyu büyüt: ${props.artifact.name}`}
            title="Büyüt"
            onClick={expand}
          >
            <ExpandIcon size={15} />
          </button>
          <SaveAction
            artifact={props.artifact}
            directUrl={directUrl}
            class={glassIconAction}
            icon
          />
          <Show when={!props.artifact.uri.startsWith('data:')}>
            <button
              type="button"
              class={glassIconAction}
              aria-label="Dosyayı aç"
              title="Dosyayı aç"
              onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
            >
              <OpenIcon size={15} />
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/** Streamed audio card: round play button, name, waveform-style scrubber and time. */
function StreamedAudioRow(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  const [section, setSection] = createSignal<HTMLElement>();
  const [audio, setAudio] = createSignal<HTMLAudioElement>();
  const [mediaError, setMediaError] = createSignal<string>();
  const playback = createPlayback(audio);
  const near = createNearViewport(section);
  const source = createStreamedSource(
    () => props.artifact,
    () => near() || playback.playing()
  );
  bindMediaSource(audio, source.url);
  const error = () => mediaError() ?? source.error();
  const detail = () =>
    error() ??
    [extensionLabel(props.artifact.name), formatBytes(source.size())].filter(Boolean).join(' · ');
  const time = () => {
    const total = formatDuration(playback.duration());
    if (!playback.started()) return total ?? '';
    return total
      ? `${formatClock(playback.current())} / ${total}`
      : formatClock(playback.current());
  };
  const directUrl = () => (source.hostStreamed() ? undefined : source.url());

  return (
    <section
      ref={setSection}
      class={audioCard}
      aria-label={`Output: ${props.artifact.name}`}
      style={{ height: `${AUDIO_ROW_H}px` }}
    >
      <button
        type="button"
        class={audioPlay}
        disabled={!source.url() || !!error()}
        aria-label={`${playback.playing() ? 'Duraklat' : 'Oynat'}: ${props.artifact.name}`}
        title={playback.playing() ? 'Duraklat' : 'Oynat'}
        onClick={playback.toggle}
      >
        {playback.playing() ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
      </button>
      <div class={audioBody}>
        <div class={audioTitleRow}>
          <span class={audioName} title={props.artifact.name}>
            {props.artifact.name}
          </span>
          <Show when={detail()}>
            <span class={audioDetail} role={error() ? 'alert' : undefined}>
              {detail()}
            </span>
          </Show>
        </div>
        <div class={audioWaveRow}>
          <WaveScrubber playback={playback} seed={props.artifact.uri} label="Ses konumu" />
          <span class={audioTime}>{time()}</span>
        </div>
      </div>
      <span class={actions}>
        <SaveAction artifact={props.artifact} directUrl={directUrl} class={iconAction} icon />
        <Show when={!props.artifact.uri.startsWith('data:') && commands().onShareArtifact}>
          <button
            type="button"
            class={iconAction}
            aria-label="Paylaş"
            title="Paylaş"
            onClick={() => commands().onShareArtifact?.(props.artifact)}
          >
            <ShareIcon />
          </button>
        </Show>
        <Show when={!props.artifact.uri.startsWith('data:')}>
          <button
            type="button"
            class={iconAction}
            aria-label="Dosyayı aç"
            title="Dosyayı aç"
            onClick={() => openArtifactFile(commands, props.artifact, props.itemId)}
          >
            <OpenIcon />
          </button>
        </Show>
      </span>
      <audio
        ref={setAudio}
        preload="metadata"
        aria-label={props.artifact.name}
        onError={(event) => {
          if (!event.currentTarget.getAttribute('src')) return;
          if (source.hostStreamed() && source.retry()) return;
          if (source.fallback()) return;
          setMediaError('Ses oynatılamadı.');
        }}
      />
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
    <section
      class={audioSection}
      aria-label={`Output: ${props.artifact.name}`}
      style={{ height: `${AUDIO_ROW_H}px` }}
    >
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
