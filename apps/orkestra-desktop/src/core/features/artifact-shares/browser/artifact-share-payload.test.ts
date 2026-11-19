import { describe, expect, it } from 'vitest';
import {
  buildSingleFileHtml,
  bytesToBase64,
  isHtmlArtifactName,
  shareFileName,
} from './artifact-share-payload';

describe('artifact-share-payload', () => {
  it('HTML adını tanır', () => {
    expect(isHtmlArtifactName('a.HTML')).toBe(true);
    expect(isHtmlArtifactName('a.png')).toBe(false);
  });

  it('dosya adını son parçaya indirger ve temizler', () => {
    expect(shareFileName('../../etc/passwd')).toBe('passwd');
    expect(shareFileName('C:\\x\\rapor<1>.html')).toBe('rapor_1_.html');
    expect(shareFileName('..')).toBe('artifact');
  });

  it('HTML artifact içeriğini olduğu gibi dışa aktarır', () => {
    const bytes = new TextEncoder().encode('<p>x</p>');
    expect(buildSingleFileHtml({ name: 'a.html', bytes })).toBe('<p>x</p>');
  });

  it('görseli gömülü sayfaya çevirir, diğer türleri reddeder', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const page = buildSingleFileHtml({ name: 'a"b.png', mimeType: 'image/png', bytes });
    expect(page).toContain(`data:image/png;base64,${bytesToBase64(bytes)}`);
    expect(page).not.toContain('a"b');
    expect(buildSingleFileHtml({ name: 'a.pdf', mimeType: 'application/pdf', bytes })).toBeNull();
  });

  it('büyük dizileri base64e çevirir', () => {
    const bytes = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(bytes)).length).toBe(100_000);
  });
});
