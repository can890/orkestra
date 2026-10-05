import { useCommands } from '@components/contexts/CommandsContext';
import { defineUnit } from '@core/units';
import { artifactKind, safeArtifactUrl } from '@lib/artifact-references';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from 'solid-js';
import { action, card, content, header, status, title } from './artifact.css';

export type ArtifactData = TranscriptArtifact & { itemId: string };

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

function previewHeight(data: ArtifactData, width: number): number {
  switch (artifactKind(data)) {
    case 'image':
    case 'video':
      return Math.min(360, Math.max(160, (width * 9) / 16)) + 44;
    case 'pdf':
      return 444;
    case 'audio':
      return 116;
    default:
      return 84;
  }
}

function Artifact(props: { data: ArtifactData; height: number }) {
  const commands = useCommands();
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [requested, setRequested] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const kind = createMemo(() => artifactKind(props.data));
  const source = createMemo(() => props.data.uri);
  const canResolve = () => !!safeArtifactUrl(props.data.uri) || !!commands().resolveArtifact;

  createEffect(() => {
    const uri = source();
    const data = untrack(() => props.data);
    const resolver = untrack(() => commands().resolveArtifact);
    if (kind() !== 'image' && !requested()) return;
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

  const open = () => {
    const classification = commands().classifyLink?.(props.data.uri);
    if (classification?.kind === 'workspace-file') {
      commands().onOpenFile?.({
        path: classification.path,
        itemId: props.data.itemId,
        source: 'resource-link',
      });
    } else if (/^https?:\/\//i.test(props.data.uri)) {
      window.open(props.data.uri, '_blank', 'noopener,noreferrer');
    }
  };
  const mediaError = () =>
    setError('Bu dosya görüntülenemedi. Kaydedebilir veya dosyayı açabilirsin.');

  return (
    <section
      class={card}
      aria-label={`Output: ${props.data.name}`}
      style={{ height: `${props.height}px` }}
    >
      <div class={header}>
        <span class={title} title={props.data.uri.startsWith('data:') ? undefined : props.data.uri}>
          {props.data.name}
        </span>
        <Show when={!url() && !loading() && canResolve()}>
          <button class={action} onClick={() => setRequested((attempt) => attempt + 1)}>
            {kind() === 'file' ? 'Kaydetmek için yükle' : 'Önizle'}
          </button>
        </Show>
        <Show when={url()}>
          {(src) => (
            <a class={action} href={src()} download={props.data.name}>
              Kaydet
            </a>
          )}
        </Show>
        <Show when={!props.data.uri.startsWith('data:')}>
          <button class={action} onClick={open}>
            Dosyayı aç
          </button>
        </Show>
      </div>
      <Show when={kind() === 'file'}>
        <span class={status}>
          {error() ?? (loading() ? 'Dosya yükleniyor…' : 'Dosyayı açabilir veya kaydedebilirsin.')}
        </span>
      </Show>
      <Show when={kind() !== 'file'}>
        <div class={content}>
          <Show
            when={!error()}
            fallback={
              <span class={status} role="alert">
                {error()}
              </span>
            }
          >
            <Show
              when={url()}
              fallback={
                <span class={status}>
                  {loading() ? 'Çıktı yükleniyor…' : 'Görüntülemek için Önizle’ye tıkla'}
                </span>
              }
            >
              {(src) => (
                <Switch>
                  <Match when={kind() === 'image'}>
                    <img
                      src={src()}
                      alt={props.data.name}
                      onError={mediaError}
                      style={{
                        width: '100%',
                        height: '100%',
                        'object-fit': 'contain',
                        cursor: 'zoom-in',
                      }}
                      onClick={() =>
                        commands().onViewImage?.({
                          attachment: { id: props.data.uri, name: props.data.name, dataUrl: src() },
                          itemId: props.data.itemId,
                          source: 'assistant-output',
                        })
                      }
                    />
                  </Match>
                  <Match when={kind() === 'video'}>
                    <video
                      src={src()}
                      controls
                      preload="metadata"
                      onError={mediaError}
                      style={{ width: '100%', height: '100%' }}
                    />
                  </Match>
                  <Match when={kind() === 'audio'}>
                    <audio
                      src={src()}
                      controls
                      preload="metadata"
                      onError={mediaError}
                      style={{ width: '100%' }}
                    />
                  </Match>
                  <Match when={kind() === 'pdf'}>
                    <object
                      data={src()}
                      type="application/pdf"
                      aria-label={props.data.name}
                      style={{ width: '100%', height: '100%', border: 0 }}
                    />
                  </Match>
                </Switch>
              )}
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  );
}

export const artifactUnitDef = defineUnit<ArtifactData, Record<string, never>>({
  kind: 'artifact',
  margin: { top: 8, bottom: 8 },
  vars: {},
  measure: (data, ctx) => previewHeight(data, ctx.width),
  Render: (props) => (
    <Artifact
      data={props.data}
      height={previewHeight(props.data, props.ctx.measureCtx?.().width ?? 640)}
    />
  ),
});
