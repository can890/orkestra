import { describe, expect, it } from 'vitest';
import { WAVE_BARS, extensionLabel, formatClock, waveHeights } from './media-controls';

describe('media controls helpers', () => {
  it('formats elapsed time by flooring', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(83.2)).toBe('1:23');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(undefined)).toBe('0:00');
  });

  it('derives an extension label from the file name', () => {
    expect(extensionLabel('render.final.mp4')).toBe('MP4');
    expect(extensionLabel('voiceover.MP3')).toBe('MP3');
    expect(extensionLabel('Render')).toBeUndefined();
    expect(extensionLabel('notes.')).toBeUndefined();
  });

  it('builds a stable waveform per file with bars inside the visible range', () => {
    const first = waveHeights('/out/voice.mp3');
    expect(first).toHaveLength(WAVE_BARS);
    expect(waveHeights('/out/voice.mp3')).toEqual(first);
    expect(waveHeights('/out/other.mp3')).not.toEqual(first);
    for (const height of first) {
      expect(height).toBeGreaterThanOrEqual(0.16);
      expect(height).toBeLessThanOrEqual(1);
    }
    // Not a flat line: the bars vary enough to read as a waveform.
    expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(0.3);
  });
});
