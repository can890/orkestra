import { describe, expect, it } from 'vitest';
import {
  artifactKind,
  artifactReferences,
  safeArtifactUrl,
  uniqueArtifacts,
} from './artifact-references';

describe('artifact references', () => {
  it('recognizes image markdown, paths with spaces, and local output links once', () => {
    expect(
      artifactReferences(
        '![cat](/tmp/cat.png)\n`/tmp/cat.png`\n[PDF](<out/My report.pdf>)\n[archive](out/files.zip)'
      )
    ).toEqual([
      { uri: '/tmp/cat.png', name: 'cat' },
      { uri: 'out/My report.pdf', name: 'PDF' },
      { uri: 'out/files.zip', name: 'archive' },
    ]);
  });
  it('names `file:` links by their file and lists a path and its `file:` URI once', () => {
    const text =
      '- [reel.mp4](/home/u/out/reel.mp4) ([file:// link](file:///home/u/out/reel.mp4))\n' +
      '- [file:// link](file:///home/u/out/my%20clip.mp4)';
    expect(artifactReferences(text)).toEqual([
      { uri: '/home/u/out/reel.mp4', name: 'reel.mp4' },
      { uri: 'file:///home/u/out/my%20clip.mp4', name: 'my clip.mp4' },
    ]);
    expect(
      uniqueArtifacts([
        { uri: 'file:///home/u/out/reel.mp4', name: 'reel.mp4' },
        { uri: '/home/u/out/reel.mp4', name: 'reel.mp4' },
      ])
    ).toHaveLength(1);
  });
  it('does not turn source paths or ordinary external links into previews', () => {
    expect(
      artifactReferences('`src/app.ts` https://example.com/docs [site](https://example.com)')
    ).toEqual([]);
  });
  it('rejects executable schemes and HTML data URLs', () => {
    expect(safeArtifactUrl('javascript:alert(1)')).toBeNull();
    expect(safeArtifactUrl('data:text/html;base64,YQ==')).toBeNull();
    expect(safeArtifactUrl('data:image/png;base64,YQ==')).toBe('data:image/png;base64,YQ==');
    expect(safeArtifactUrl('/tmp/cat.png')).toBeNull();
  });
  it.each([
    ['video.mp4', 'video'],
    ['voice.mp3', 'audio'],
    ['report.pdf', 'pdf'],
    ['cat.png', 'image'],
    ['archive.zip', 'file'],
  ])('classifies %s', (uri, kind) => {
    expect(artifactKind({ uri, name: uri })).toBe(kind);
  });
});
