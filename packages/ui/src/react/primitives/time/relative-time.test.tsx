import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime, toCompactLabel } from './relative-time';

const NOW = new Date('2026-03-04T16:20:30Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('toCompactLabel', () => {
  it('shows "şimdi" for timestamps under 60 seconds old', () => {
    expect(toCompactLabel(new Date(NOW.getTime() - 30_000), NOW.getTime())).toBe('şimdi');
    expect(toCompactLabel(new Date(NOW.getTime() - 59_999), NOW.getTime())).toBe('şimdi');
  });

  it('abbreviates distance units in Turkish', () => {
    expect(toCompactLabel(minutesAgo(5), NOW.getTime())).toBe('5dk');
    expect(toCompactLabel(minutesAgo(90), NOW.getTime())).toBe('1sa');
    expect(toCompactLabel(minutesAgo(60 * 24 * 3), NOW.getTime())).toBe('3g');
    expect(toCompactLabel(minutesAgo(60 * 24 * 40), NOW.getTime())).toBe('1ay');
    expect(toCompactLabel(minutesAgo(60 * 24 * 400), NOW.getTime())).toBe('1yıl');
  });

  it('measures the distance from the given reference time', () => {
    const later = NOW.getTime() + 2 * 60 * 60_000;
    expect(toCompactLabel(NOW, later)).toBe('2sa');
  });
});

describe('RelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the full distance with the Turkish suffix', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = renderToStaticMarkup(<RelativeTime value={minutesAgo(3)} />);
    expect(html).toContain('3 dakika önce');
    expect(html).not.toMatch(/ago|minutes?/);
  });

  it('appends the muted "önce" suffix in compact mode', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = renderToStaticMarkup(<RelativeTime value={minutesAgo(60 * 24 * 3)} compact ago />);
    expect(html).toContain('3g');
    expect(html).toContain(' önce</span>');
  });

  it('skips the suffix while showing "şimdi"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = renderToStaticMarkup(<RelativeTime value={NOW} compact ago />);
    expect(html).toContain('şimdi');
    expect(html).not.toContain('önce');
  });
});
