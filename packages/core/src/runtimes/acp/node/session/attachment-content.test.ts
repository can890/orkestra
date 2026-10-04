import { describe, expect, it } from 'vitest';
import { attachmentContent } from './attachment-content';
describe('attachment capability routing', () => {
  const image = { data: 'aGVsbG8=', mimeType: 'image/png', name: 'test.png', targetPath: '/remote/test.png' };
  it('sends native image content only to image-capable agents', () => {
    expect(attachmentContent(image, true)).toEqual({ type: 'image', data: image.data, mimeType: image.mimeType });
    expect(attachmentContent(image, false)).toMatchObject({ type: 'text', text: expect.stringContaining('/remote/test.png') });
  });
  it('sends video paths without placing binary data in text', () => {
    const result = attachmentContent({ ...image, mimeType: 'video/mp4', targetPath: '/remote/video.mp4' }, true);
    expect(result).toMatchObject({ type: 'text', text: expect.stringContaining('/remote/video.mp4') });
    expect(JSON.stringify(result)).not.toContain(image.data);
  });
  it('reports missing host paths instead of silently dropping files', () => {
    expect(() => attachmentContent({ data: '', mimeType: 'video/mp4' }, false)).toThrow();
  });
});
