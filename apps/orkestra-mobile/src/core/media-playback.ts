/**
 * Sohbetteki video ve ses kartlarının oynatma mantığı (React yok): medya öğesinin olaylarını tek
 * bir anlık görüntüye çevirir ve oynat/duraklat/sar/sessiz eylemlerini sunar. Masaüstündeki
 * `packages/chat-ui/.../media-controls.tsx` (`createPlayback`) ile aynı davranış:
 * - Aynı anda tek kaynak çalar; yenisi başlayınca önceki duraklar.
 * - `poster` açıkken süre 4 sn'den uzunsa kapak olarak %10 ilerideki (en çok 3 sn) kare gösterilir;
 *   ilk oynatma baştan başlar.
 * - Kaynak bırakılıp yeniden bağlanırsa kalınan konuma dönülür.
 * - Süresi bilinmeyen/sonsuz kaynakta sarma kapalıdır.
 */

// ── Saf yardımcılar ───────────────────────────────────────────────────────────

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

/** Dosya uzantısı etiket olarak ("render.final.mp4" → "MP4"); uzantı yoksa `undefined`. */
export function mediaExtensionLabel(name: string): string | undefined {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
  return match ? match[1]!.toUpperCase() : undefined;
}

/** Kapak karesinin konumu (saniye): süre 4 sn'den uzunsa %10 ileride, en çok 3 sn; yoksa yok. */
export function posterTime(duration: number | undefined): number | undefined {
  if (!duration || !Number.isFinite(duration) || duration <= 4) return undefined;
  return Math.min(duration * 0.1, 3);
}

/** Yeniden bağlanınca dönülecek konum; anlamsızsa (başta ya da sonda) `undefined`. */
export function resumeTarget(resumeAt: number, duration: number | undefined): number | undefined {
  if (!(resumeAt > 0.05)) return undefined;
  if (duration && resumeAt >= duration - 0.25) return undefined;
  return resumeAt;
}

export type TimeRangesLike = {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
};

/** Geçerli konumu içeren tamponun sonu, 0–1. */
export function bufferedFraction(
  ranges: TimeRangesLike | undefined,
  currentTime: number,
  duration: number | undefined
): number {
  if (!ranges || !duration) return 0;
  let end = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.start(i) <= currentTime + 0.5) end = Math.max(end, ranges.end(i));
  }
  return Math.max(0, Math.min(1, end / duration));
}

/** Dokunma noktasının çubuk üzerindeki oranı, 0–1. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width));
}

export const WAVE_BARS = 40;

/**
 * Dosya yolundan türetilen sabit, dalga biçimi görünümlü çubuk yükseklikleri (0–1). Gerçek ses
 * verisi değildir; dosya indirilmeden çizilebilen, her dosyada farklı duran bir ilerleme çubuğu.
 * Masaüstündeki `waveHeights` ile aynı algoritma.
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

/**
 * Dolu dalga çubuğu sayısı. Çubuk sayısı kadar adım: çalarken her `timeupdate`'te değil, yalnızca
 * bir çubuk dolunca değişir. Hiç başlamamış kaynakta boştur.
 */
export function filledBars(
  fraction: number,
  started: boolean,
  dragging: boolean,
  count = WAVE_BARS
): number {
  if (fraction <= 0 && !started && !dragging) return 0;
  return Math.min(count, Math.max(fraction > 0 ? 1 : 0, Math.round(fraction * count)));
}

// ── Tek kaynak kuralı ─────────────────────────────────────────────────────────

type Pausable = { pause(): void };
let activeMedia: Pausable | undefined;

/** `media` çalmaya başladı: başka bir kaynak çalıyorsa duraklatılır. */
export function claimActiveMedia(media: Pausable): void {
  if (activeMedia && activeMedia !== media) activeMedia.pause();
  activeMedia = media;
}

export function releaseActiveMedia(media: Pausable): void {
  if (activeMedia === media) activeMedia = undefined;
}

// ── Oynatma denetleyicisi ─────────────────────────────────────────────────────

/** `HTMLMediaElement`'in kullanılan yüzü (testte sahte nesneyle sağlanabilir). */
export type MediaLike = EventTarget & {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly duration: number;
  readonly volume: number;
  readonly buffered?: TimeRangesLike;
  currentTime: number;
  muted: boolean;
  play(): Promise<void> | void;
  pause(): void;
  getAttribute(name: string): string | null;
};

export type PlaybackSnapshot = {
  readonly playing: boolean;
  /** Kullanıcı en az bir kez oynattı; kontrol çubuğu bundan sonra görünür. */
  readonly started: boolean;
  readonly current: number;
  /** Sonlu süre; canlı/süresi bilinmeyen kaynakta `undefined` (sarma kapalı). */
  readonly duration: number | undefined;
  /** Geçerli konumu içeren tamponun sonu, 0–1. */
  readonly buffered: number;
  readonly muted: boolean;
  /** Oynatma sürerken veri bekleniyor. */
  readonly waiting: boolean;
};

const INITIAL: PlaybackSnapshot = {
  playing: false,
  started: false,
  current: 0,
  duration: undefined,
  buffered: 0,
  muted: false,
  waiting: false,
};

export class PlaybackController {
  private snapshot: PlaybackSnapshot;
  private readonly listeners = new Set<() => void>();
  private media: MediaLike | null = null;
  private detachListeners: (() => void) | null = null;
  private resumeAt = 0;
  private posterAt: number | undefined;

  constructor(private readonly options: { poster?: boolean; started?: boolean } = {}) {
    this.snapshot = { ...INITIAL, started: options.started ?? false };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): PlaybackSnapshot => this.snapshot;

  private set(patch: Partial<PlaybackSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof PlaybackSnapshot)[]) {
      if (this.snapshot[key] !== patch[key]) changed = true;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Medya öğesini bağlar (`null` bırakır). Önceki öğenin dinleyicileri kaldırılır. */
  readonly attach = (media: MediaLike | null): void => {
    if (media === this.media) return;
    this.detachListeners?.();
    this.detachListeners = null;
    if (this.media) releaseActiveMedia(this.media);
    this.media = media;
    this.posterAt = undefined;
    if (!media) {
      this.set({ playing: false, waiting: false });
      return;
    }
    const handlers: [string, () => void][] = [];
    const on = (type: string, handler: () => void) => handlers.push([type, handler]);
    const finiteDuration = () => {
      const total = media.duration;
      return Number.isFinite(total) && total > 0 ? total : undefined;
    };
    const updateBuffered = () => {
      const total = finiteDuration();
      if (!total) return;
      this.set({ buffered: bufferedFraction(media.buffered, media.currentTime, total) });
    };

    on('loadedmetadata', () => {
      const total = finiteDuration();
      this.set({ duration: total });
      const resume = resumeTarget(this.resumeAt, total);
      if (resume !== undefined) {
        media.currentTime = resume;
        return;
      }
      const poster = this.options.poster && !this.snapshot.started ? posterTime(total) : undefined;
      if (poster !== undefined) {
        this.posterAt = poster;
        media.currentTime = poster;
      }
    });
    on('durationchange', () => this.set({ duration: finiteDuration() }));
    on('play', () => {
      claimActiveMedia(media);
      if (this.posterAt !== undefined) {
        if (Math.abs(media.currentTime - this.posterAt) < 0.2) media.currentTime = 0;
        this.posterAt = undefined;
      }
      this.set({ started: true, playing: true });
    });
    on('playing', () => this.set({ waiting: false }));
    on('canplay', () => this.set({ waiting: false }));
    on('waiting', () => this.set({ waiting: true }));
    on('pause', () => this.set({ playing: false, waiting: false }));
    on('ended', () => {
      this.resumeAt = 0;
      this.set({ playing: false, waiting: false });
    });
    on('timeupdate', () => {
      // Kapak karesinin konumu ilerleme sayılmaz.
      if (this.posterAt !== undefined) return;
      if (this.snapshot.started && !media.ended) this.resumeAt = media.currentTime;
      this.set({ current: media.currentTime });
      updateBuffered();
    });
    on('progress', updateBuffered);
    on('volumechange', () => this.set({ muted: media.muted || media.volume === 0 }));
    on('emptied', () => {
      this.posterAt = undefined;
      this.set({ playing: false, waiting: false, buffered: 0 });
    });

    for (const [type, handler] of handlers) media.addEventListener(type, handler);
    this.detachListeners = () => {
      for (const [type, handler] of handlers) media.removeEventListener(type, handler);
    };
  };

  /** Duruyorsa oynatır; zaten çalıyorsa bir şey yapmaz (iki kez çağrılması güvenli). */
  readonly play = (): void => {
    const media = this.media;
    if (!media || !media.getAttribute('src')) return;
    if (!media.paused && !media.ended) return;
    try {
      void Promise.resolve(media.play()).catch(() => undefined);
    } catch {
      // Oynatma reddedildi (ör. kaynak hazır değil); durum `play` olayıyla güncellenir.
    }
  };

  readonly toggle = (): void => {
    const media = this.media;
    if (!media || !media.getAttribute('src')) return;
    if (media.paused || media.ended) this.play();
    else media.pause();
  };

  readonly pause = (): void => this.media?.pause();

  readonly seek = (seconds: number): void => {
    const media = this.media;
    if (!media) return;
    const total = this.snapshot.duration;
    const next = Math.max(0, total ? Math.min(seconds, total) : seconds);
    this.posterAt = undefined;
    media.currentTime = next;
    if (this.snapshot.started) this.resumeAt = next;
    this.set({ current: next });
  };

  readonly seekBy = (delta: number): void => {
    if (this.media) this.seek(this.media.currentTime + delta);
  };

  readonly toggleMute = (): void => {
    if (this.media) this.media.muted = !this.media.muted;
  };

  dispose(): void {
    this.attach(null);
    this.listeners.clear();
  }
}
