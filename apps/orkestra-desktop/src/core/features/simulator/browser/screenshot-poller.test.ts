import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScreenshotPoller, type ScreenshotCapture } from './screenshot-poller';

const frame = { success: true as const, data: { data: 'AAA', mimeType: 'image/jpeg' } };

describe('createScreenshotPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('yaklaşık 2 fps sırayla kare ister', async () => {
    const capture = vi.fn<ScreenshotCapture>(async () => frame);
    const frames: string[] = [];
    const poller = createScreenshotPoller({
      capture,
      onFrame: (url) => frames.push(url),
      onError: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(frames[0]).toBe('data:image/jpeg;base64,AAA');
    poller.stop();
  });

  it('stop sonrası yeni kare istemez ve uçuştaki sonucu yok sayar', async () => {
    let release: (() => void) | undefined;
    const capture = vi.fn<ScreenshotCapture>(
      () =>
        new Promise((resolve) => {
          release = () => resolve(frame);
        })
    );
    const onFrame = vi.fn();
    const poller = createScreenshotPoller({ capture, onFrame, onError: () => {} });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFrame).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('hatada geri çekilir ve hatayı bildirir', async () => {
    const capture = vi.fn<ScreenshotCapture>(async () => ({
      success: false as const,
      message: 'cihaz kapalı',
    }));
    const onError = vi.fn();
    const poller = createScreenshotPoller({
      capture,
      onFrame: () => {},
      onError,
      errorBackoffMs: 3_000,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith('cihaz kapalı');
    poller.stop();
  });

  it('görünür değilken kare istemez, görünür olunca devam eder', async () => {
    let visible = false;
    const capture = vi.fn<ScreenshotCapture>(async () => frame);
    const poller = createScreenshotPoller({
      capture,
      onFrame: () => {},
      onError: () => {},
      isVisible: () => visible,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(capture).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(capture).toHaveBeenCalled();
    poller.stop();
  });
});
