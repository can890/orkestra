import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioPlayer, usePlayback, VideoFrame } from './MediaPlayer';

function Video(props: { url?: string; error?: string; loading?: boolean }) {
  const playback = usePlayback({ poster: true });
  return (
    <VideoFrame
      playback={playback}
      name="render.mp4"
      url={props.url}
      loading={props.loading ?? false}
      error={props.error}
      fallbackDuration={10}
      onExpand={() => undefined}
    />
  );
}

describe('VideoFrame', () => {
  it('renders our own controls instead of the native ones', () => {
    const html = renderToStaticMarkup(<Video url="http://127.0.0.1:1/t/s/render.mp4" />);
    expect(html).toContain('<video');
    expect(html).not.toMatch(/<video[^>]*\scontrols/);
    expect(html).toMatch(/<video[^>]*playsinline/i);
    expect(html).toContain('aria-label="Oynat: render.mp4"');
    // Başlamadan önce süre etiketi; kontrol çubuğu gizli.
    expect(html).toContain('mp-duration-chip">0:10<');
    expect(html).toContain('data-visible="false"');
  });

  it('shows the error inside the frame without a video element', () => {
    const html = renderToStaticMarkup(<Video url="http://x/y.mp4" error="Video oynatılamadı." />);
    expect(html).not.toContain('<video');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Video oynatılamadı.');
    expect(html).not.toContain('mp-big-play');
  });

  it('shows a loading message while the stream is prepared', () => {
    const html = renderToStaticMarkup(<Video loading />);
    expect(html).toContain('Video hazırlanıyor…');
  });
});

describe('AudioPlayer', () => {
  it('renders a custom card without native controls', () => {
    const html = renderToStaticMarkup(
      <AudioPlayer
        name="voice.mp3"
        seed="/out/voice.mp3"
        url="http://127.0.0.1:1/t/s/voice.mp3"
        detail="MP3 · 157 KB"
        loading={false}
      />
    );
    expect(html).toContain('<audio');
    expect(html).not.toMatch(/<audio[^>]*\scontrols/);
    expect(html).toContain('aria-label="Oynat: voice.mp3"');
    expect(html).toContain('MP3 · 157 KB');
    expect(html.match(/mp-wave-bar/g)?.length).toBe(40);
  });

  it('disables play and shows the error status when the source failed', () => {
    const html = renderToStaticMarkup(
      <AudioPlayer
        name="voice.mp3"
        seed="/out/voice.mp3"
        detail="MP3"
        loading={false}
        error="Ses oynatılamadı."
        status={{ text: 'Ses oynatılamadı.', isError: true }}
      />
    );
    expect(html).not.toContain('<audio');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('role="alert"');
  });
});
