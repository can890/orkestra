import { describe, expect, it } from 'vitest';
import {
  bufferedFraction,
  claimActiveMedia,
  filledBars,
  formatClock,
  fractionAt,
  mediaExtensionLabel,
  PlaybackController,
  posterTime,
  resumeTarget,
  waveHeights,
  WAVE_BARS,
  type MediaLike,
  type TimeRangesLike,
} from './media-playback';

/** `HTMLMediaElement`'in denetleyicinin kullandığı yüzünü taklit eder. */
class FakeMedia extends EventTarget implements MediaLike {
  paused = true;
  ended = false;
  duration = Number.NaN;
  volume = 1;
  muted = false;
  currentTime = 0;
  buffered: TimeRangesLike = { length: 0, start: () => 0, end: () => 0 };
  src: string | null = 'http://127.0.0.1/x';
  plays = 0;

  getAttribute(name: string): string | null {
    return name === 'src' ? this.src : null;
  }
  play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  }
  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
  loadMetadata(duration: number): void {
    this.duration = duration;
    this.emit('loadedmetadata');
  }
}

describe('formatClock', () => {
  it('rounds down and pads', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });
  it('treats unknown values as zero', () => {
    expect(formatClock(undefined)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('mediaExtensionLabel', () => {
  it('returns the upper-case extension', () => {
    expect(mediaExtensionLabel('render.final.mp4')).toBe('MP4');
    expect(mediaExtensionLabel('voice.Mp3 ')).toBe('MP3');
  });
  it('returns undefined without a plausible extension', () => {
    expect(mediaExtensionLabel('README')).toBeUndefined();
    expect(mediaExtensionLabel('archive.toolongext')).toBeUndefined();
  });
});

describe('posterTime / resumeTarget', () => {
  it('takes the poster 10% in, at most 3 s, only for clips longer than 4 s', () => {
    expect(posterTime(undefined)).toBeUndefined();
    expect(posterTime(4)).toBeUndefined();
    expect(posterTime(10)).toBeCloseTo(1);
    expect(posterTime(600)).toBe(3);
    expect(posterTime(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
  it('resumes only from a meaningful position', () => {
    expect(resumeTarget(0, 10)).toBeUndefined();
    expect(resumeTarget(4, 10)).toBe(4);
    expect(resumeTarget(9.9, 10)).toBeUndefined();
    expect(resumeTarget(4, undefined)).toBe(4);
  });
});

describe('bufferedFraction / fractionAt', () => {
  const ranges = (list: [number, number][]): TimeRangesLike => ({
    length: list.length,
    start: (i) => list[i]![0],
    end: (i) => list[i]![1],
  });
  it('uses the range that contains the current position', () => {
    expect(
      bufferedFraction(
        ranges([
          [0, 4],
          [6, 8],
        ]),
        1,
        10
      )
    ).toBeCloseTo(0.4);
    expect(
      bufferedFraction(
        ranges([
          [0, 4],
          [6, 8],
        ]),
        6.2,
        10
      )
    ).toBeCloseTo(0.8);
    expect(bufferedFraction(ranges([[0, 4]]), 1, undefined)).toBe(0);
  });
  it('clamps touch positions to the track', () => {
    expect(fractionAt(50, 0, 200)).toBe(0.25);
    expect(fractionAt(-10, 0, 200)).toBe(0);
    expect(fractionAt(500, 0, 200)).toBe(1);
    expect(fractionAt(10, 0, 0)).toBe(0);
  });
});

describe('waveHeights / filledBars', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = waveHeights('/tmp/voice.mp3');
    expect(a).toHaveLength(WAVE_BARS);
    expect(waveHeights('/tmp/voice.mp3')).toEqual(a);
    expect(waveHeights('/tmp/other.mp3')).not.toEqual(a);
    for (const h of a) {
      expect(h).toBeGreaterThanOrEqual(0.16);
      expect(h).toBeLessThanOrEqual(1);
    }
  });
  it('fills nothing before start and at least one bar once moving', () => {
    expect(filledBars(0, false, false)).toBe(0);
    expect(filledBars(0.001, true, false)).toBe(1);
    expect(filledBars(0.5, true, false)).toBe(WAVE_BARS / 2);
    expect(filledBars(1, true, false)).toBe(WAVE_BARS);
  });
});

describe('PlaybackController', () => {
  it('toggles play and pause and reports the state', () => {
    const controller = new PlaybackController();
    const media = new FakeMedia();
    controller.attach(media);
    expect(controller.getSnapshot().playing).toBe(false);
    controller.toggle();
    expect(controller.getSnapshot()).toMatchObject({ playing: true, started: true });
    controller.toggle();
    expect(controller.getSnapshot()).toMatchObject({ playing: false, started: true });
  });

  it('notifies subscribers only on change', () => {
    const controller = new PlaybackController();
    const media = new FakeMedia();
    controller.attach(media);
    let calls = 0;
    controller.subscribe(() => (calls += 1));
    media.emit('pause');
    expect(calls).toBe(0);
    controller.toggle();
    expect(calls).toBe(1);
  });

  it('does nothing without a source', () => {
    const controller = new PlaybackController();
    const media = new FakeMedia();
    media.src = null;
    controller.attach(media);
    controller.toggle();
    expect(media.plays).toBe(0);
  });

  it('shows a poster frame and starts the first play from 0', () => {
    const controller = new PlaybackController({ poster: true });
    const media = new FakeMedia();
    controller.attach(media);
    media.loadMetadata(20);
    expect(media.currentTime).toBe(2);
    media.emit('timeupdate');
    expect(controller.getSnapshot().current).toBe(0);
    controller.toggle();
    expect(media.currentTime).toBe(0);
  });

  it('skips the poster seek for short clips', () => {
    const controller = new PlaybackController({ poster: true });
    const media = new FakeMedia();
    controller.attach(media);
    media.loadMetadata(3);
    expect(media.currentTime).toBe(0);
  });

  it('resumes at the last position after the source is re-attached', () => {
    const controller = new PlaybackController({ poster: true });
    const first = new FakeMedia();
    controller.attach(first);
    first.loadMetadata(20);
    controller.toggle();
    first.currentTime = 7;
    first.emit('timeupdate');
    controller.attach(null);
    expect(controller.getSnapshot().playing).toBe(false);

    const second = new FakeMedia();
    controller.attach(second);
    second.loadMetadata(20);
    expect(second.currentTime).toBe(7);
  });

  it('disables seeking clamps for unknown duration and clamps for known', () => {
    const controller = new PlaybackController();
    const media = new FakeMedia();
    controller.attach(media);
    media.loadMetadata(Number.POSITIVE_INFINITY);
    expect(controller.getSnapshot().duration).toBeUndefined();
    media.loadMetadata(10);
    controller.seek(50);
    expect(media.currentTime).toBe(10);
    controller.seek(-1);
    expect(media.currentTime).toBe(0);
  });

  it('plays one source at a time', () => {
    const a = new PlaybackController();
    const b = new PlaybackController();
    const mediaA = new FakeMedia();
    const mediaB = new FakeMedia();
    a.attach(mediaA);
    b.attach(mediaB);
    a.toggle();
    b.toggle();
    expect(mediaA.paused).toBe(true);
    expect(a.getSnapshot().playing).toBe(false);
    expect(b.getSnapshot().playing).toBe(true);
    claimActiveMedia(mediaA);
    expect(mediaB.paused).toBe(true);
  });

  it('tracks waiting and mute', () => {
    const controller = new PlaybackController();
    const media = new FakeMedia();
    controller.attach(media);
    controller.toggle();
    media.emit('waiting');
    expect(controller.getSnapshot().waiting).toBe(true);
    media.emit('playing');
    expect(controller.getSnapshot().waiting).toBe(false);
    controller.toggleMute();
    media.emit('volumechange');
    expect(controller.getSnapshot().muted).toBe(true);
  });
});
