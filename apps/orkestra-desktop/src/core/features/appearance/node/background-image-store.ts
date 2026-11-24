// Arka plan görselini uygulama verisi altındaki `appearance/` dizinine kopyalar. Dosya adı
// içeriğin özetinden türetilir; kullanıcının özgün dosya yolu hiçbir yerde saklanmaz.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BACKGROUND_FILE_NAME_RE,
  BACKGROUND_IMAGE_MAX_BYTES,
  extensionForMimeType,
  isBackgroundMimeType,
} from '../api/background';
import type { BackgroundImageDto, SaveBackgroundResult } from '../api/contract';

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Dosyanın ilk baytları bildirilen türle uyuşuyor mu? (Uzantı/MIME sahteciliğine karşı.) */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export class BackgroundImageStore {
  constructor(private readonly directory: string) {}

  async save(input: { mimeType: string; dataBase64: string }): Promise<SaveBackgroundResult> {
    if (!isBackgroundMimeType(input.mimeType)) return { ok: false, reason: 'unsupported-type' };
    // Base64 boyutundan bayt boyutunu kabaca kestir; büyükse çözmeden reddet.
    if ((input.dataBase64.length * 3) / 4 > BACKGROUND_IMAGE_MAX_BYTES + 4) {
      return { ok: false, reason: 'too-large' };
    }
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.byteLength === 0) return { ok: false, reason: 'unsupported-type' };
    if (bytes.byteLength > BACKGROUND_IMAGE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    if (sniffImageType(bytes) !== input.mimeType) return { ok: false, reason: 'unsupported-type' };
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const fileName = `background-${digest}.${extensionForMimeType(input.mimeType)}`;
    try {
      await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, fileName);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, target);
      return { ok: true, fileName };
    } catch {
      return { ok: false, reason: 'write-failed' };
    }
  }

  async read(fileName: string): Promise<BackgroundImageDto | null> {
    if (!BACKGROUND_FILE_NAME_RE.test(fileName)) return null;
    try {
      const bytes = await readFile(join(this.directory, fileName));
      const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
      return {
        mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
        dataBase64: bytes.toString('base64'),
      };
    } catch {
      return null;
    }
  }

  async prune(keep: string | null): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((name) => BACKGROUND_FILE_NAME_RE.test(name) && name !== keep)
        .map((name) => rm(join(this.directory, name), { force: true }))
    );
  }
}
