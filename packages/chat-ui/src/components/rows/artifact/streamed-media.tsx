import { useCommands } from '@components/contexts/CommandsContext';
import { safeArtifactUrl } from '@lib/artifact-references';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';

// ── Yerleşim ──────────────────────────────────────────────────────────────────
// measure() ve Render aynı sayıları kullanır; satır yüksekliği kartla birebir eşleşir.

export const VIDEO_META_H = 32;
export const VIDEO_TILE_META_H = 28;
const VIDEO_BORDER = 2;
const VIDEO_MAX_W = 560;
const VIDEO_MAX_H = 360;
const VIDEO_MIN_CARD_W = 300;
const VIDEO_TILE_MIN_W = 220;
const VIDEO_TILE_MAX_W = 340;
export const VIDEO_GALLERY_GAP = 8;
export const DEFAULT_VIDEO_ASPECT = 16 / 9;

export type SingleVideoBox = { cardW: number; frameH: number; height: number };

/** Tek video kartı: oran korunur (dikey videolar daralır), yükseklik 360 px ile sınırlı. */
export function singleVideoBox(width: number, aspect: number): SingleVideoBox {
  const ratio =
    Number.isFinite(aspect) && aspect > 0.1 && aspect < 10 ? aspect : DEFAULT_VIDEO_ASPECT;
  const maxW = Math.max(160, Math.min(width, VIDEO_MAX_W));
  let frameH = maxW / ratio;
  let videoW = maxW;
  if (frameH > VIDEO_MAX_H) {
    frameH = VIDEO_MAX_H;
    videoW = frameH * ratio;
  }
  const cardW = Math.min(maxW, Math.max(videoW, Math.min(VIDEO_MIN_CARD_W, maxW)));
  const roundedFrame = Math.round(frameH);
  return {
    cardW: Math.round(cardW),
    frameH: roundedFrame,
    height: roundedFrame + VIDEO_META_H + VIDEO_BORDER,
  };
}

export type VideoGalleryLayout = {
  cols: number;
  tileW: number;
  frameH: number;
  tileH: number;
  height: number;
};

/** Birden çok çıktı: 16:9 karolardan düzgün bir ızgara (genişliğe göre 1–2 sütun). */
export function videoGalleryLayout(width: number, count: number): VideoGalleryLayout {
  const cols = width >= VIDEO_TILE_MIN_W * 2 + VIDEO_GALLERY_GAP ? 2 : 1;
  const tileW = Math.max(
    120,
    Math.floor(Math.min(VIDEO_TILE_MAX_W, (width - VIDEO_GALLERY_GAP * (cols - 1)) / cols))
  );
  const frameH = Math.round((tileW * 9) / 16);
  const tileH = frameH + VIDEO_TILE_META_H + VIDEO_BORDER;
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    cols,
    tileW,
    frameH,
    tileH,
    height: rows * tileH + (rows - 1) * VIDEO_GALLERY_GAP,
  };
}

// Video oranları URI başına saklanır; measure() sinyali okuduğu için meta veri gelince satır
// yeniden ölçülür (bir kez, kart ilk kez yüklendiğinde).
const aspects = new Map<string, ReturnType<typeof createSignal<number>>>();

function aspectEntry(uri: string) {
  let entry = aspects.get(uri);
  if (!entry) {
    entry = createSignal(DEFAULT_VIDEO_ASPECT);
    aspects.set(uri, entry);
  }
  return entry;
}

export function videoAspect(uri: string): number {
  return aspectEntry(uri)[0]();
}

export function setVideoAspect(uri: string, width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  const next = Math.round((width / height) * 1000) / 1000;
  const [read, write] = aspectEntry(uri);
  if (Math.abs(untrack(read) - next) > 0.01) write(next);
}

// ── Biçimlendirme ─────────────────────────────────────────────────────────────

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toLocaleString('tr-TR', { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Görünüm alanına yakınlık ──────────────────────────────────────────────────

function scrollParent(element: Element): Element | null {
  let parent = element.parentElement;
  while (parent) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Kart kaydırma alanının görünen kısmına ~1 ekran yakınken true. Uzun bir dökümde yalnızca
 * yakındaki kartlar akış açar; uzaklaşan (ve oynamayan) kart kaynağını bırakır.
 */
export function createNearViewport(target: Accessor<Element | undefined>): Accessor<boolean> {
  const supported = typeof IntersectionObserver !== 'undefined';
  const [near, setNear] = createSignal(!supported);
  createEffect(() => {
    const element = target();
    if (!element || !supported) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { root: scrollParent(element), rootMargin: '600px 0px' }
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return near;
}

// ── Akış adresi ───────────────────────────────────────────────────────────────

export type StreamedSource = {
  url: Accessor<string | undefined>;
  size: Accessor<number | undefined>;
  error: Accessor<string | undefined>;
  /** Adres ana bilgisayardan (özel protokol) geldi; indirme bağlantısı olarak kullanılmaz. */
  hostStreamed: Accessor<boolean>;
  /** Belirteç süresi dolmuş olabilir: bir kez yeni adres iste. */
  retry: () => boolean;
};

/**
 * `active` true iken çıktı için oynatılabilir adres tutar: doğrudan güvenli adres (http, data,
 * blob) ya da ana bilgisayarın `mediaUrlForArtifact` komutu. `active` false olunca adres
 * bırakılır (dispose), boyut bilgisi kalır.
 */
export function createStreamedSource(
  artifact: Accessor<TranscriptArtifact>,
  active: Accessor<boolean>
): StreamedSource {
  const commands = useCommands();
  const [url, setUrl] = createSignal<string | undefined>();
  const [size, setSize] = createSignal<number | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [hostStreamed, setHostStreamed] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  let retried = false;

  createEffect(() => {
    attempt();
    if (!active()) return;
    const current = untrack(artifact);
    const direct = safeArtifactUrl(current.uri);
    if (direct) {
      setHostStreamed(false);
      setUrl(direct);
      return;
    }
    const mint = untrack(() => commands().mediaUrlForArtifact);
    if (!mint) return;
    const controller = new AbortController();
    let alive = true;
    let release: (() => void) | undefined;
    setError(undefined);
    void mint(current, { signal: controller.signal })
      .then((result) => {
        if (!alive) {
          result.dispose?.();
          return;
        }
        release = result.dispose;
        if (result.size !== undefined) setSize(result.size);
        setHostStreamed(true);
        setUrl(result.url);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : 'Çıktı açılamadı.');
      });
    onCleanup(() => {
      alive = false;
      controller.abort();
      release?.();
      setUrl(undefined);
    });
  });

  return {
    url,
    size,
    error,
    hostStreamed,
    retry: () => {
      if (retried) return false;
      retried = true;
      setAttempt((n) => n + 1);
      return true;
    },
  };
}

/**
 * Medya öğesine kaynağı bağlar/çözer. Kaynak kaldırılırken `load()` çağrısı açık ağ isteğini
 * hemen kapatır; aksi halde Chromium akışı öğe çöp toplanana kadar açık tutabilir.
 */
export function bindMediaSource(
  element: Accessor<HTMLMediaElement | undefined>,
  url: Accessor<string | undefined>
): void {
  createEffect(() => {
    const media = element();
    if (!media) return;
    const src = url();
    if (src) {
      if (media.getAttribute('src') !== src) media.setAttribute('src', src);
    } else if (media.hasAttribute('src')) {
      media.removeAttribute('src');
      media.load();
    }
  });
  onCleanup(() => {
    const media = untrack(element);
    if (media?.hasAttribute('src')) {
      media.removeAttribute('src');
      media.load();
    }
  });
}
