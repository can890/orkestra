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
} from 'solid-js';
import type { ChatMediaGalleryItem } from '@/commands';
import {
  audioSection,
  compactAction,
  fileList,
  fileName,
  filePillSection,
  galleryMediaImg,
  galleryMediaSection,
  galleryMediaVideo,
  glassActionBtn,
  groupRoot,
  hoverOverlay,
  mediaPlaceholder,
  mediaStrip,
  singleImageEl,
  singleMediaSection,
  singleVideoEl,
  singleVideoWrap,
  videoExpandCorner,
  videoPlayBadge,
  videoPlayTrigger,
} from './artifact.css';

export type ArtifactData = TranscriptArtifact & { itemId: string };
export type ArtifactGroupData = { itemId: string; items: TranscriptArtifact[] };
export type ArtifactUnitInput = ArtifactGroupData | ArtifactData;

const SINGLE_IMAGE_MAX_H = 180;
const SINGLE_VIDEO_H = 160;
const GALLERY_TILE_W = 144;
const GALLERY_TILE_H = 108;
const GALLERY_GAP = 8;
const AUDIO_ROW_H = 44;
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
    blocks.push(artifactKind(media[0]!) === 'video' ? SINGLE_VIDEO_H : SINGLE_IMAGE_MAX_H);
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
    setMediaError: () => setError('Bu dosya görüntülenemedi. Kaydedebilir veya dosyayı açabilirsin.'),
    openExternal,
  };
}

function MediaItemView(props: {
  artifact: TranscriptArtifact;
  itemId: string;
  single: boolean;
  index: number;
  mediaList: TranscriptArtifact[];
}) {
  const commands = useCommands();
  const kind = createMemo(() => artifactKind(props.artifact) as 'image' | 'video');
  // Images resolve immediately; direct safe video URLs can preview right away, while workspace video paths remain lazy until 'Önizle'.
  const state = useResolvedArtifact(
    () => props.artifact,
    () => kind() === 'image' || !!safeArtifactUrl(props.artifact.uri)
  );

  const openLightbox = (resolvedSrc?: string) => {
    const gallery: ChatMediaGalleryItem[] = props.mediaList.map((item, idx) => {
      const k = artifactKind(item) === 'video' ? 'video' : 'image';
      const itemSrc =
        idx === props.index
          ? resolvedSrc ?? safeArtifactUrl(item.uri) ?? undefined
          : safeArtifactUrl(item.uri) ?? undefined;
      return {
        id: item.uri,
        src: itemSrc,
        alt: item.name,
        kind: k,
        mimeType: item.mimeType,
        artifact: item,
      };
    });
    const currentSrc = resolvedSrc ?? state.url() ?? safeArtifactUrl(props.artifact.uri) ?? undefined;
    commands().onViewImage?.({
      attachment: {
        id: props.artifact.uri,
        name: props.artifact.name,
        dataUrl: currentSrc,
        mimeType: props.artifact.mimeType,
      },
      itemId: props.itemId,
      source: 'assistant-output',
      kind: kind(),
      gallery,
      index: props.index,
    });
  };

  const openFileWithItemId = () => {
    const classification = commands().classifyLink?.(props.artifact.uri);
    if (classification?.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: classification.path,
        itemId: props.itemId,
        source: 'resource-link',
      });
    } else if (/^https?:\/\//i.test(props.artifact.uri)) {
      window.open(props.artifact.uri, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <section
      class={props.single ? singleMediaSection : galleryMediaSection}
      aria-label={`Output: ${props.artifact.name}`}
    >
      <div class={hoverOverlay}>
        <Show when={state.url()}>
          {(src) => (
            <a class={glassActionBtn} href={src()} download={props.artifact.name}>
              Kaydet
            </a>
          )}
        </Show>
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
          <button type="button" class={glassActionBtn} onClick={openFileWithItemId}>
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
            <div class={props.single && kind() === 'video' ? singleVideoWrap : mediaPlaceholder}>
              <Show
                when={kind() === 'video' && !state.loading() && state.canResolve()}
                fallback={<span>{state.loading() ? 'Yükleniyor…' : props.artifact.name}</span>}
              >
                <button
                  type="button"
                  class={videoPlayTrigger}
                  onClick={state.requestResolve}
                >
                  Önizle
                </button>
              </Show>
            </div>
          }
        >
          {(src) => (
            <Show
              when={kind() === 'image'}
              fallback={
                <div class={props.single ? singleVideoWrap : undefined} style={props.single ? undefined : { width: '100%', height: '100%', position: 'relative' }}>
                  <video
                    src={src()}
                    controls={props.single}
                    muted={!props.single}
                    playsinline
                    preload="metadata"
                    onError={state.setMediaError}
                    onClick={() => {
                      if (!props.single) openLightbox(src());
                    }}
                    class={props.single ? singleVideoEl : galleryMediaVideo}
                  />
                  <Show when={!props.single}>
                    <span class={videoPlayBadge}>
                      <PlayIcon size={11} />
                    </span>
                  </Show>
                  <button
                    type="button"
                    class={videoExpandCorner}
                    aria-label={`Videoyu büyüt: ${props.artifact.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openLightbox(src());
                    }}
                  >
                    <ExpandIcon />
                  </button>
                </div>
              }
            >
              <img
                src={src()}
                alt={props.artifact.name}
                onError={state.setMediaError}
                class={props.single ? singleImageEl : galleryMediaImg}
                onClick={() => openLightbox(src())}
              />
            </Show>
          )}
        </Show>
      </Show>
    </section>
  );
}

function AudioItemView(props: { artifact: TranscriptArtifact; itemId: string }) {
  const commands = useCommands();
  const state = useResolvedArtifact(
    () => props.artifact,
    () => !!safeArtifactUrl(props.artifact.uri)
  );

  const openFile = () => {
    const classification = commands().classifyLink?.(props.artifact.uri);
    if (classification?.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: classification.path,
        itemId: props.itemId,
        source: 'resource-link',
      });
    } else if (/^https?:\/\//i.test(props.artifact.uri)) {
      window.open(props.artifact.uri, '_blank', 'noopener,noreferrer');
    }
  };

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
              style={{ flex: 1, height: '28px', 'min-width': 0 }}
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
        <button type="button" class={compactAction} onClick={openFile}>
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

  const openFile = () => {
    const classification = commands().classifyLink?.(props.artifact.uri);
    if (classification?.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: classification.path,
        itemId: props.itemId,
        source: 'resource-link',
      });
    } else if (/^https?:\/\//i.test(props.artifact.uri)) {
      window.open(props.artifact.uri, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <section class={filePillSection} aria-label={`Output: ${props.artifact.name}`}>
      <GenericFileIcon />
      <span
        class={fileName}
        title={props.artifact.uri.startsWith('data:') ? undefined : props.artifact.uri}
      >
        {state.error() ? `${props.artifact.name} · ${state.error()}` : props.artifact.name}
      </span>
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
        <button type="button" class={compactAction} onClick={openFile}>
          Dosyayı aç
        </button>
      </Show>
    </section>
  );
}

function ArtifactGroup(props: { data: ArtifactUnitInput }) {
  const group = createMemo(() => normalizeArtifactGroup(props.data));
  const partitioned = createMemo(() => partitionArtifacts(group().items));

  return (
    <div class={groupRoot}>
      <Show when={partitioned().media.length > 0}>
        <div class={mediaStrip}>
          <For each={partitioned().media}>
            {(artifact, index) => (
              <MediaItemView
                artifact={artifact}
                itemId={group().itemId}
                single={partitioned().media.length === 1}
                index={index()}
                mediaList={partitioned().media}
              />
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
  Render: (props) => <ArtifactGroup data={props.data} />,
});
