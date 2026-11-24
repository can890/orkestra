import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import { BACKGROUND_FILE_NAME_RE, BACKGROUND_IMAGE_MIME_TYPES } from './background';

export const appearanceDomain = 'appearance' as const;

export type SaveBackgroundResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: 'too-large' | 'unsupported-type' | 'write-failed' };

export type BackgroundImageDto = { mimeType: string; dataBase64: string };

/**
 * Görünüm özelleştirme sözleşmesi: arka plan görseli uygulama verisine KOPYALANIR (özgün yol
 * saklanmaz) ve arayüz onu buradan okur.
 */
export const appearanceContract = defineContract({
  saveBackgroundImage: procedure({
    input: z.object({
      mimeType: z.enum(BACKGROUND_IMAGE_MIME_TYPES),
      dataBase64: z.string().min(1),
    }),
    output: z.custom<SaveBackgroundResult>(),
  }),
  readBackgroundImage: procedure({
    input: z.object({ fileName: z.string().regex(BACKGROUND_FILE_NAME_RE) }),
    output: z.custom<BackgroundImageDto | null>(),
  }),
  /** `keep` dışındaki tüm arka plan dosyalarını siler (null → hepsi). */
  pruneBackgroundImages: procedure({
    input: z.object({ keep: z.string().regex(BACKGROUND_FILE_NAME_RE).nullable() }),
    output: z.void(),
  }),
});
