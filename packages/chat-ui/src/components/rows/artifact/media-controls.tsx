// Sohbetteki video ve ses kartlarının ortak oynatma mantığı ile kontrol parçaları: ikonlar,
// oynatma durumu, video ilerleme çubuğu ve ses dalga çubuğu.
import {
  Index,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from 'solid-js';
import {
  scrub,
  scrubBuffered,
  scrubPlayed,
  scrubThumb,
  scrubTrack,
  wave,
  waveBar,
} from './media-player.css';

// ── İkonlar ───────────────────────────────────────────────────────────────────

type IconProps = { size?: number };

function Stroke(props: IconProps & { children: JSX.Element }) {
  const s = () => props.size ?? 16;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  const s = () => props.size ?? 16;
  return (
    <svg width={s()} height={s()} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {/* Üçgen optik olarak ortalansın diye yarım birim sağda. */}
      <path d="M4.9 2.6a.7.7 0 0 1 1.06-.6l8.3 5.4a.7.7 0 0 1 0 1.2l-8.3 5.4a.7.7 0 0 1-1.06-.6V2.6Z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  const s = () => props.size ?? 16;
  return (
    <svg width={s()} height={s()} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.2" y="2.4" width="3.4" height="11.2" rx="1.1" />
      <rect x="9.4" y="2.4" width="3.4" height="11.2" rx="1.1" />
    </svg>
  );
}

export function VolumeIcon(props: IconProps & { muted?: boolean }) {
  return (
    <Stroke size={props.size}>
      <path d="M2.4 6.3h2.3L7.9 3.5v9L4.7 9.7H2.4z" fill="currentColor" />
      {props.muted ? (
        <path d="m10.6 6.3 3.2 3.4M13.8 6.3l-3.2 3.4" />
      ) : (
        <path d="M10.4 6a2.9 2.9 0 0 1 0 4M12.2 4.2a5.5 5.5 0 0 1 0 7.6" />
      )}
    </Stroke>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <Stroke size={props.size}>
      <path d="M9.6 2.6h3.8v3.8M13.4 2.6 9.2 6.8M6.4 13.4H2.6V9.6M2.6 13.4l4.2-4.2" />
    </Stroke>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Stroke size={props.size}>
      <path d="M8 2.4v7.8M4.7 7 8 10.3 11.3 7M2.8 13.2h10.4" />
    </Stroke>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <Stroke size={props.size}>
      <path d="M8 9.8V2.4M5.3 5 8 2.3 10.7 5M3.2 8.4v3.8a1.1 1.1 0 0 0 1.1 1.1h7.4a1.1 1.1 0 0 0 1.1-1.1V8.4" />
    </Stroke>
  );
}

export function OpenIcon(props: IconProps) {
  return (
    <Stroke size={props.size}>
      <path d="M9.4 2.7h3.9v3.9M13.1 2.9 7.7 8.3M11.9 9.3v2.8a1.1 1.1 0 0 1-1.1 1.1H3.9a1.1 1.1 0 0 1-1.1-1.1V5.2a1.1 1.1 0 0 1 1.1-1.1h2.8" />
    </Stroke>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Stroke size={props.size}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5.2v3.3M8 10.7v.1" />
    </Stroke>
  );
}

// ── Biçimlendirme ─────────────────────────────────────────────────────────────

/** Geçen süre: aşağı yuvarlanır (0:59,9 → 0:59), böylece toplam süreyi geçmez. */
export function formatClock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Dosya uzantısı etiket olarak ("render.final.mp4" → "MP4"). */
export function extensionLabel(name: string): string | undefined {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
  return match ? match[1]!.toUpperCase() : undefined;
}

// ── Oynatma durumu ────────────────────────────────────────────────────────────

export type Playback = {
  playing: Accessor<boolean>;
  /** Kullanıcı en az bir kez oynattı; kontrol çubuğu bundan sonra görünür. */
  started: Accessor<boolean>;
  current: Accessor<number>;
  /** Sonlu süre; canlı/süresi bilinmeyen kaynakta `undefined` (sarma kapalı). */
  duration: Accessor<number | undefined>;
  /** Geçerli konumu içeren tamponun sonu, 0–1. */
  buffered: Accessor<number>;
  muted: Accessor<boolean>;
  /** Oynatma sürerken veri bekleniyor. */
  waiting: Accessor<boolean>;
  toggle: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  seekBy: (delta: number) => void;
  toggleMute: () => void;
};

// Aynı anda tek kaynak çalar: yenisi başlayınca önceki duraklar.
let activeMedia: HTMLMediaElement | undefined;

/**
 * Medya öğesinin durumunu sinyallere bağlar. `poster` açıkken video ilk karesi yerine biraz
 * ilerideki bir kareyi kapak olarak gösterir (çoğu video siyah kareyle açılır); ilk oynatmada
 * baştan başlar. Kaynak bırakılıp yeniden bağlanırsa kalınan konuma döner.
 */
export function createPlayback(
  element: Accessor<HTMLMediaElement | undefined>,
  options: { poster?: boolean } = {}
): Playback {
  const [playing, setPlaying] = createSignal(false);
  const [started, setStarted] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal<number>();
  const [buffered, setBuffered] = createSignal(0);
  const [muted, setMuted] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  let resumeAt = 0;
  let posterAt: number | undefined;

  createEffect(() => {
    const media = element();
    if (!media) return;
    const on = (type: string, handler: () => void) => {
      media.addEventListener(type, handler);
      onCleanup(() => media.removeEventListener(type, handler));
    };
    const finiteDuration = () => {
      const total = media.duration;
      return Number.isFinite(total) && total > 0 ? total : undefined;
    };
    const updateBuffered = () => {
      const total = finiteDuration();
      if (!total) return;
      let end = 0;
      for (let i = 0; i < media.buffered.length; i += 1) {
        if (media.buffered.start(i) <= media.currentTime + 0.5) {
          end = Math.max(end, media.buffered.end(i));
        }
      }
      setBuffered(Math.min(1, end / total));
    };

    on('loadedmetadata', () => {
      const total = finiteDuration();
      setDuration(total);
      if (resumeAt > 0.05 && (!total || resumeAt < total - 0.25)) {
        media.currentTime = resumeAt;
      } else if (options.poster && total && total > 4 && !untrack(started)) {
        posterAt = Math.min(total * 0.1, 3);
        media.currentTime = posterAt;
      }
    });
    on('durationchange', () => setDuration(finiteDuration()));
    on('play', () => {
      if (activeMedia && activeMedia !== media) activeMedia.pause();
      activeMedia = media;
      if (posterAt !== undefined) {
        if (Math.abs(media.currentTime - posterAt) < 0.2) media.currentTime = 0;
        posterAt = undefined;
      }
      setStarted(true);
      setPlaying(true);
    });
    on('playing', () => setWaiting(false));
    on('canplay', () => setWaiting(false));
    on('waiting', () => setWaiting(true));
    on('pause', () => {
      setPlaying(false);
      setWaiting(false);
    });
    on('ended', () => {
      setPlaying(false);
      setWaiting(false);
      resumeAt = 0;
    });
    on('timeupdate', () => {
      // Kapak karesinin konumu ilerleme sayılmaz.
      if (posterAt !== undefined) return;
      setCurrent(media.currentTime);
      if (untrack(started) && !media.ended) resumeAt = media.currentTime;
      updateBuffered();
    });
    on('progress', updateBuffered);
    on('volumechange', () => setMuted(media.muted || media.volume === 0));
    on('emptied', () => {
      setPlaying(false);
      setWaiting(false);
      setBuffered(0);
      posterAt = undefined;
    });
    onCleanup(() => {
      if (activeMedia === media) activeMedia = undefined;
    });
  });

  const seek = (seconds: number) => {
    const media = untrack(element);
    if (!media) return;
    const total = untrack(duration);
    const next = Math.max(0, total ? Math.min(seconds, total) : seconds);
    posterAt = undefined;
    media.currentTime = next;
    setCurrent(next);
    if (untrack(started)) resumeAt = next;
  };

  return {
    playing,
    started,
    current,
    duration,
    buffered,
    muted,
    waiting,
    toggle: () => {
      const media = untrack(element);
      if (!media || !media.getAttribute('src')) return;
      if (media.paused || media.ended) void media.play().catch(() => undefined);
      else media.pause();
    },
    pause: () => untrack(element)?.pause(),
    seek,
    seekBy: (delta) => {
      const media = untrack(element);
      if (media) seek(media.currentTime + delta);
    },
    toggleMute: () => {
      const media = untrack(element);
      if (media) media.muted = !media.muted;
    },
  };
}

// ── Sarma (sürükleyerek konum seçme) ──────────────────────────────────────────

type DragEvent = PointerEvent & { currentTarget: HTMLElement };

function createSeekDrag(playback: Playback, onActiveChange?: (active: boolean) => void) {
  const [drag, setDrag] = createSignal<number>();
  let lastSeek = 0;
  const fractionAt = (event: DragEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  };
  const commit = (fraction: number) => {
    const total = playback.duration();
    if (total) playback.seek(fraction * total);
  };
  const finish = (event: DragEvent) => {
    const fraction = drag();
    if (fraction === undefined) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(undefined);
    commit(fraction);
    onActiveChange?.(false);
  };
  return {
    dragging: () => drag() !== undefined,
    fraction: () => {
      const total = playback.duration();
      return drag() ?? (total ? Math.max(0, Math.min(1, playback.current() / total)) : 0);
    },
    handlers: {
      onClick: (event: MouseEvent) => event.stopPropagation(),
      onDblClick: (event: MouseEvent) => event.stopPropagation(),
      onPointerDown: (event: DragEvent) => {
        if (event.button !== 0 || !playback.duration()) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const fraction = fractionAt(event);
        setDrag(fraction);
        lastSeek = performance.now();
        commit(fraction);
        onActiveChange?.(true);
      },
      onPointerMove: (event: DragEvent) => {
        if (drag() === undefined) return;
        const fraction = fractionAt(event);
        setDrag(fraction);
        // Uzak dosyada her harekette istek açmamak için sarma seyreltilir.
        const now = performance.now();
        if (now - lastSeek > 120) {
          lastSeek = now;
          commit(fraction);
        }
      },
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}

function sliderKeys(playback: Playback) {
  return (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      playback.seekBy(event.key === 'ArrowLeft' ? -5 : 5);
    }
  };
}

/** Video üstündeki ince ilerleme çubuğu (tamponlanan + oynatılan kısım, sürüklenebilir). */
export function VideoScrubber(props: {
  playback: Playback;
  label: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const drag = createSeekDrag(props.playback, (active) => props.onActiveChange?.(active));
  const percent = () => `${(drag.fraction() * 100).toFixed(2)}%`;
  return (
    <div
      class={scrub}
      role="slider"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={Math.round(props.playback.duration() ?? 0)}
      aria-valuenow={Math.round(props.playback.current())}
      data-active={drag.dragging()}
      data-disabled={!props.playback.duration()}
      {...drag.handlers}
    >
      <div class={scrubTrack}>
        <div
          class={scrubBuffered}
          style={{ width: `${(props.playback.buffered() * 100).toFixed(2)}%` }}
        />
        <div class={scrubPlayed} style={{ width: percent() }} />
      </div>
      <div class={scrubThumb} style={{ left: percent() }} />
    </div>
  );
}

export const WAVE_BARS = 48;

/**
 * Dosya adından türetilen sabit, dalga biçimi görünümlü çubuk yükseklikleri (0–1). Gerçek ses
 * verisi değildir; dosya indirilmeden çizilebilen, her dosyada farklı duran bir ilerleme çubuğu.
 */
export function waveHeights(seed: string, count = WAVE_BARS): number[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  }
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
  const a = random() * Math.PI * 2;
  const b = random() * Math.PI * 2;
  return Array.from({ length: count }, (_, index) => {
    const envelope = 0.6 + 0.4 * Math.sin((index / Math.max(1, count - 1)) * Math.PI);
    const shape =
      Math.abs(Math.sin(index * 0.55 + a)) * 0.5 +
      Math.abs(Math.sin(index * 0.17 + b)) * 0.25 +
      random() * 0.35;
    return Math.max(0.16, Math.min(1, shape * envelope + 0.08));
  });
}

/** Ses kartının dalga biçimli ilerleme çubuğu. */
export function WaveScrubber(props: { playback: Playback; seed: string; label: string }) {
  const drag = createSeekDrag(props.playback);
  const heights = createMemo(() => waveHeights(props.seed));
  // Çubuk sayısı kadar adım: çalarken saniyede birkaç kez değil, yalnızca çubuk dolunca değişir.
  const filled = createMemo(() => {
    const fraction = drag.fraction();
    if (fraction <= 0 && !props.playback.started() && !drag.dragging()) return 0;
    return Math.max(fraction > 0 ? 1 : 0, Math.round(fraction * WAVE_BARS));
  });
  return (
    <div
      class={wave}
      role="slider"
      tabindex={props.playback.duration() ? 0 : -1}
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={Math.round(props.playback.duration() ?? 0)}
      aria-valuenow={Math.round(props.playback.current())}
      data-disabled={!props.playback.duration()}
      onKeyDown={sliderKeys(props.playback)}
      {...drag.handlers}
    >
      <Index each={heights()}>
        {(height, index) => (
          <span
            class={waveBar}
            data-on={index < filled()}
            style={{ height: `${Math.round(height() * 100)}%` }}
          />
        )}
      </Index>
    </div>
  );
}
