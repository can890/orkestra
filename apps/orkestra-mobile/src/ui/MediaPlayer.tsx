/**
 * Sohbetteki video ve ses kartlarının kendi oynatıcısı (tarayıcının yerel `controls` arayüzü
 * yerine). Görünüm ve davranış masaüstündeki `packages/chat-ui/.../artifact/media-controls.tsx`
 * tasarımının dokunmatik uyarlamasıdır; akış (yerel vekil adresi, yedekler, hatalar)
 * `MediaPreview.tsx`'te kalır, burası yalnızca sunum ve kontrollerdir.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { formatDuration } from '@/core/artifacts';
import {
  filledBars,
  formatClock,
  fractionAt,
  PlaybackController,
  waveHeights,
  WAVE_BARS,
  type MediaLike,
  type PlaybackSnapshot,
} from '@/core/media-playback';
import { AlertCircleIcon, MaximizeIcon, PauseIcon, PlayIcon, VolumeIcon } from './icons';

/** Oynatırken son dokunuştan bu kadar sonra kontrol çubuğu gizlenir. */
const BAR_HIDE_MS = 2500;
/** Uzak dosyada her harekette istek açmamak için sürüklerken sarma seyreltilir. */
const SEEK_THROTTLE_MS = 120;

export type Playback = {
  /** `<video>`/`<audio>` öğesine verilecek ref. */
  ref: (element: HTMLMediaElement | null) => void;
  state: PlaybackSnapshot;
  controller: PlaybackController;
};

export function usePlayback(options: { poster?: boolean; started?: boolean } = {}): Playback {
  const [controller] = useState(() => new PlaybackController(options));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  // Bırakma ref üzerinden olur: React, öğe kalkınca ref'i `null` ile çağırır (`attach(null)`).
  const ref = useCallback(
    (element: HTMLMediaElement | null) => controller.attach(element as MediaLike | null),
    [controller]
  );
  return { ref, state, controller };
}

/** Süre metni (saniye): kısa biçim, yuvarlanmış ("0:10"). */
export function durationLabel(seconds: number | undefined): string {
  return seconds ? formatDuration(seconds * 1000) : '';
}

// ── Sarma (sürükleyerek konum seçme) ──────────────────────────────────────────

function useSeekDrag(playback: Playback, onActiveChange?: (active: boolean) => void) {
  const { state, controller } = playback;
  const [drag, setDrag] = useState<number | undefined>(undefined);
  const lastSeek = useRef(0);
  const total = state.duration;
  const commit = (fraction: number) => {
    if (total) controller.seek(fraction * total);
  };
  const locate = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return fractionAt(event.clientX, rect.left, rect.width);
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag === undefined) return;
    event.stopPropagation();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Yakalama zaten bırakıldı.
    }
    setDrag(undefined);
    commit(drag);
    onActiveChange?.(false);
  };
  const fraction = drag ?? (total ? Math.max(0, Math.min(1, state.current / total)) : 0);
  return {
    dragging: drag !== undefined,
    fraction,
    handlers: {
      onClick: (event: SyntheticEvent) => event.stopPropagation(),
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        event.stopPropagation();
        if (event.button !== 0 || !total) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Yakalama desteklenmiyorsa sürükleme öğe üzerinde kaldıkça çalışır.
        }
        const next = locate(event);
        setDrag(next);
        lastSeek.current = performance.now();
        commit(next);
        onActiveChange?.(true);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        if (drag === undefined) return;
        const next = locate(event);
        setDrag(next);
        const now = performance.now();
        if (now - lastSeek.current > SEEK_THROTTLE_MS) {
          lastSeek.current = now;
          commit(next);
        }
      },
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}

function VideoScrubber(props: { playback: Playback; onActiveChange: (active: boolean) => void }) {
  const { state } = props.playback;
  const drag = useSeekDrag(props.playback, props.onActiveChange);
  const percent = `${(drag.fraction * 100).toFixed(2)}%`;
  return (
    <div
      className="mp-scrub"
      role="slider"
      aria-label="Video konumu"
      aria-valuemin={0}
      aria-valuemax={Math.round(state.duration ?? 0)}
      aria-valuenow={Math.round(state.current)}
      data-active={drag.dragging}
      data-disabled={!state.duration}
      {...drag.handlers}
    >
      <div className="mp-scrub-track">
        <div
          className="mp-scrub-buffered"
          style={{ width: `${(state.buffered * 100).toFixed(2)}%` }}
        />
        <div className="mp-scrub-played" style={{ width: percent }} />
      </div>
      <div className="mp-scrub-thumb" style={{ left: percent }} />
    </div>
  );
}

function WaveScrubber(props: { playback: Playback; seed: string }) {
  const { state } = props.playback;
  const drag = useSeekDrag(props.playback);
  const heights = useMemo(() => waveHeights(props.seed), [props.seed]);
  const filled = filledBars(drag.fraction, state.started, drag.dragging, WAVE_BARS);
  return (
    <div
      className="mp-wave"
      role="slider"
      aria-label="Ses konumu"
      aria-valuemin={0}
      aria-valuemax={Math.round(state.duration ?? 0)}
      aria-valuenow={Math.round(state.current)}
      data-disabled={!state.duration}
      {...drag.handlers}
    >
      {heights.map((height, index) => (
        <span
          // Çubuklar sabit sırada; dizin anahtarı güvenli.
          key={index}
          className="mp-wave-bar"
          data-on={index < filled}
          style={{ height: `${Math.round(height * 100)}%` }}
        />
      ))}
    </div>
  );
}

// ── Video çerçevesi ───────────────────────────────────────────────────────────

/**
 * Video çerçevesi: kapak karesi, ortada camsı oynat düğmesi, başlamadan önce süre etiketi;
 * oynatma başlayınca altta degrade zeminli kontrol çubuğu (sarma, oynat/duraklat, süre, ses,
 * büyüt). Dokunma: oynayan videoya ilk dokunuş çubuğu gösterir, çubuk görünürken dokunuş
 * oynat/duraklat yapar. Çubuk oynatırken son dokunuştan 2,5 sn sonra gizlenir, duraklatılmışken
 * hep görünür.
 */
export function VideoFrame(props: {
  playback: Playback;
  name: string;
  url?: string;
  poster?: string;
  /** Kaynak hazırlanırken (akış açılıyor) çerçevede gösterilir. */
  loading: boolean;
  error?: string | null;
  /** Oynatıcı süreyi okuyamadıysa yerel yoklamadan gelen süre (saniye). */
  fallbackDuration?: number;
  /** Galeri karosu: küçük oynat düğmesi; başladıktan sonra ortadaki düğme gizlenir. */
  compact?: boolean;
  /** Tam ekran katmanı: çerçeve bulunduğu alanı doldurur, köşe yuvarlaması yok. */
  fill?: boolean;
  style?: CSSProperties;
  onExpand?: () => void;
  onLoadedMetadata?: (element: HTMLVideoElement) => void;
  onError?: () => void;
}) {
  const { playback } = props;
  const { state, controller } = playback;
  const [touched, setTouched] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const poke = () => {
    setTouched(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTouched(false), BAR_HIDE_MS);
  };

  const error = props.error ?? null;
  const playable = Boolean(props.url) && !error;
  const barVisible = playable && state.started && (!state.playing || touched || scrubbing);
  const showBigPlay = playable && !state.playing && !scrubbing && !(props.compact && state.started);
  const total = state.duration ?? props.fallbackDuration;
  const totalText = durationLabel(total);

  const onFrameTap = () => {
    if (!playable) return;
    if (state.playing && !barVisible) {
      poke();
      return;
    }
    controller.toggle();
    poke();
  };
  const onScrubActive = (active: boolean) => {
    setScrubbing(active);
    if (!active) poke();
  };
  const stop = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <div
      className={`mp-frame${props.fill ? ' is-fill' : ''}`}
      style={props.style}
      data-playing={state.playing}
      onClick={onFrameTap}
    >
      {playable ? (
        <video
          ref={playback.ref}
          className="mp-video"
          src={props.url}
          poster={props.poster}
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          aria-label={props.name}
          onLoadedMetadata={(event) => props.onLoadedMetadata?.(event.currentTarget)}
          onError={() => props.onError?.()}
        />
      ) : (
        <div className="mp-placeholder" role={error ? 'alert' : undefined}>
          {error ? (
            <>
              <span className="mp-placeholder-icon">
                <AlertCircleIcon size={18} />
              </span>
              <span className="mp-placeholder-text">{error}</span>
            </>
          ) : props.loading ? (
            <>
              <span className="mp-spinner is-small" />
              <span className="mp-placeholder-text">Video hazırlanıyor…</span>
            </>
          ) : null}
        </div>
      )}

      {showBigPlay ? (
        <button
          type="button"
          className="mp-big-play"
          data-compact={Boolean(props.compact)}
          aria-label={`Oynat: ${props.name}`}
          onClick={(event) => {
            event.stopPropagation();
            controller.toggle();
            poke();
          }}
        >
          <PlayIcon size={props.compact ? 18 : 22} />
        </button>
      ) : null}

      {playable && state.playing && state.waiting ? <span className="mp-spinner" /> : null}

      {playable && !state.started && totalText ? (
        <span className="mp-duration-chip">{totalText}</span>
      ) : null}

      {playable ? (
        <div
          className="mp-bar"
          data-visible={barVisible}
          aria-hidden={!barVisible}
          onClick={stop}
          onPointerDown={poke}
        >
          <VideoScrubber playback={playback} onActiveChange={onScrubActive} />
          <div className="mp-bar-row">
            <button
              type="button"
              className="mp-bar-btn"
              tabIndex={barVisible ? 0 : -1}
              aria-label={state.playing ? 'Duraklat' : 'Oynat'}
              onClick={() => {
                controller.toggle();
                poke();
              }}
            >
              {state.playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            </button>
            <span className="mp-bar-time">
              {formatClock(state.current)}
              {totalText ? <span className="mp-bar-time-total"> / {totalText}</span> : null}
            </span>
            <span className="mp-bar-spacer" />
            <button
              type="button"
              className="mp-bar-btn"
              tabIndex={barVisible ? 0 : -1}
              aria-label={state.muted ? 'Sesi aç' : 'Sesi kapat'}
              onClick={controller.toggleMute}
            >
              <VolumeIcon size={19} muted={state.muted} />
            </button>
            {props.onExpand ? (
              <button
                type="button"
                className="mp-bar-btn"
                tabIndex={barVisible ? 0 : -1}
                aria-label="Tam ekran oynat"
                onClick={props.onExpand}
              >
                <MaximizeIcon size={17} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Ses kartı ─────────────────────────────────────────────────────────────────

/**
 * Ses kartı: yuvarlak dolu oynat/duraklat düğmesi, ad + `UZANTI · boyut`, dalga biçimli sarma
 * çubuğu ve süre (başlamadan önce toplam, sonra `geçen / toplam`).
 */
export function AudioPlayer(props: {
  name: string;
  /** Dalga çubuklarının tohumu (dosya yolu). */
  seed: string;
  url?: string;
  detail: string;
  loading: boolean;
  error?: string | null;
  /** Kartın altında, tüm genişlikte gösterilen durum satırı (hata, indirme ilerlemesi). */
  status?: { text: string; isError: boolean } | null;
  actions?: ReactNode;
  onLoadedMetadata?: (element: HTMLAudioElement) => void;
  onError?: () => void;
}) {
  const playback = usePlayback();
  const { state, controller } = playback;
  const playable = Boolean(props.url) && !props.error;
  const totalText = durationLabel(state.duration);
  const time = !state.started
    ? totalText
    : totalText
      ? `${formatClock(state.current)} / ${totalText}`
      : formatClock(state.current);

  return (
    <div className="mp-audio-card">
      <div className="mp-audio-row">
        <button
          type="button"
          className="mp-audio-play"
          disabled={!playable}
          aria-label={`${state.playing ? 'Duraklat' : 'Oynat'}: ${props.name}`}
          onClick={controller.toggle}
        >
          {props.loading && !playable && !props.error ? (
            <span className="mp-spinner is-small is-inverse" />
          ) : state.playing ? (
            <PauseIcon size={15} />
          ) : (
            <PlayIcon size={15} />
          )}
        </button>
        <div className="mp-audio-body">
          <div className="mp-audio-title">
            <span className="mp-audio-name">{props.name}</span>
            {props.detail ? <span className="mp-audio-detail">{props.detail}</span> : null}
          </div>
          <div className="mp-audio-wave-row">
            <WaveScrubber playback={playback} seed={props.seed} />
            {time ? <span className="mp-audio-time">{time}</span> : null}
          </div>
        </div>
        {props.actions ? <div className="mp-actions">{props.actions}</div> : null}
      </div>
      {props.status ? (
        <div
          className={`mp-status${props.status.isError ? ' is-error' : ''}`}
          role={props.status.isError ? 'alert' : undefined}
        >
          {props.status.text}
        </div>
      ) : null}
      {playable ? (
        <audio
          ref={playback.ref}
          src={props.url}
          preload="metadata"
          aria-label={props.name}
          onLoadedMetadata={(event) => props.onLoadedMetadata?.(event.currentTarget)}
          onError={() => props.onError?.()}
        />
      ) : null}
    </div>
  );
}
