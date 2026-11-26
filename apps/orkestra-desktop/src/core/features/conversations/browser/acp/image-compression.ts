/**
 * Retina ekran görüntüleri gibi büyük görselleri sohbete eklemeden önce
 * okunurluğu koruyarak hafifletir ve boyut etiketini biçimlendirir.
 */

const COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const MAX_EDGE_PX = 2048;

export function formatImageByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export async function compressImageIfNeeded(file: File): Promise<File> {
  if (
    file.size <= COMPRESS_THRESHOLD_BYTES ||
    file.type === 'image/gif' ||
    typeof document === 'undefined'
  ) {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const outputType = file.type === 'image/png' ? 'image/webp' : file.type || 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputType, 0.86)
    );

    if (!blob || blob.size >= file.size) {
      return file;
    }

    return new File([blob], file.name, {
      type: blob.type || outputType,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}
