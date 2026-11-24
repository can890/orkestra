// Arka plan görselinin uygulama verisine kopyalanmasını gerçek bir geçici dizin ve wire
// denetleyicisi (test kablosu) üzerinden uçtan uca doğrular.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestWire } from '@orkestra/wire/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_IMAGE_MAX_BYTES } from '../api/background';
import { appearanceContract } from '../api/contract';
import { BackgroundImageStore, sniffImageType } from './background-image-store';
import { createAppearanceWireController } from './wire-controller';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('BackgroundImageStore', () => {
  const dirs: string[] = [];
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'orkestra-appearance-'));
    dirs.push(root);
    const directory = join(root, 'appearance');
    const wire = createTestWire(
      appearanceContract,
      createAppearanceWireController(new BackgroundImageStore(directory))
    );
    disposers.push(() => wire.dispose());
    return { root, directory, client: wire.client };
  }

  it('copies the image into app data under a content-derived name and reads it back', async () => {
    const { client, directory } = await setup();
    // The original file lives elsewhere; only its bytes cross the wire.
    const saved = await client.saveBackgroundImage({ mimeType: 'image/png', dataBase64: b64(PNG) });
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) throw new Error('save failed');
    expect(saved.fileName).toMatch(/^background-[a-f0-9]{32}\.png$/);
    expect(await readdir(directory)).toEqual([saved.fileName]);

    const again = await client.saveBackgroundImage({ mimeType: 'image/png', dataBase64: b64(PNG) });
    expect(again).toEqual(saved);

    const read = await client.readBackgroundImage({ fileName: saved.fileName });
    expect(read).toEqual({ mimeType: 'image/png', dataBase64: b64(PNG) });
  });

  it('rejects unsupported, mislabelled and oversized images', async () => {
    const { client } = await setup();
    expect(
      await client.saveBackgroundImage({ mimeType: 'image/png', dataBase64: b64(JPEG) })
    ).toEqual({ ok: false, reason: 'unsupported-type' });
    const huge = new Uint8Array(BACKGROUND_IMAGE_MAX_BYTES + 16);
    huge.set(PNG);
    expect(
      await client.saveBackgroundImage({ mimeType: 'image/png', dataBase64: b64(huge) })
    ).toEqual({ ok: false, reason: 'too-large' });
  });

  it('prunes every background except the kept one and refuses path traversal', async () => {
    const { client, directory } = await setup();
    const png = await client.saveBackgroundImage({ mimeType: 'image/png', dataBase64: b64(PNG) });
    const jpg = await client.saveBackgroundImage({ mimeType: 'image/jpeg', dataBase64: b64(JPEG) });
    if (!png.ok || !jpg.ok) throw new Error('save failed');
    await writeFile(join(directory, 'unrelated.txt'), 'keep me');

    await client.pruneBackgroundImages({ keep: jpg.fileName });
    expect((await readdir(directory)).sort()).toEqual([jpg.fileName, 'unrelated.txt'].sort());

    await expect(
      client.readBackgroundImage({ fileName: '../unrelated.txt' as never })
    ).rejects.toThrow();
    expect(await client.readBackgroundImage({ fileName: png.fileName })).toBeNull();
  });

  it('sniffs image signatures', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg'))).toBeNull();
  });
});
