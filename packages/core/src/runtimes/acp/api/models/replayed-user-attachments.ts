import { z } from 'zod';
import type { AttachmentRef } from '#primitives/acp-transcript/api/normalized-event';
import { attachmentMetadataSchema, MAX_ATTACHMENT_FILES } from '#services/attachments/api';
import { stripHiddenContext } from './hidden-context';

const savedAttachmentsSchema = z
  .array(attachmentMetadataSchema.extend({ id: z.uuid() }))
  .max(MAX_ATTACHMENT_FILES);
const ATTACHMENT_CONTEXT =
  /<orkestra_context>\s*<orkestra_attachments>([^<]*)<\/orkestra_attachments>\s*<\/orkestra_context>/g;
const IMAGE_LINK =
  /\[@image\]\((data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2})\)/gi;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,[A-Za-z0-9+/]+={0,2}$/i;
const MAX_REPLAY_IMAGE_LENGTH = 12 * 1024 * 1024;

const ANTIGRAVITY_ATTACHMENT_NOTICE =
  /\[Kullanıcı (?:görsel|dosya) ekledi: ([^\r\n]+?) \((?:URI: [^\r\n]+?, )?MIME: ([\w.+-]+\/[\w.+-]+)\)\. (?:Görseli|Dosyayı) incelemek için read_file aracını bu tam dosya yoluyla kullan\.\]/g;
const HOST_ATTACHMENT_NOTICE =
  /Kullanıcının eklediği dosya bu çalışma sunucusuna yüklendi\. Dosya bilgileri: (\{[^\r\n]+?\})\. Dosyayı uygun araçlarla inceleyin; desteklemediğiniz bir içeriği görmüş gibi yanıtlamayın\./g;
const OWNED_ATTACHMENT_PATH =
  /[\\/]conversations[\\/][^\\/]+[\\/]([\da-f-]{36})[\\/]content(?:\.[a-z0-9]{1,16})?$/i;

export function stripAntigravityAttachmentNotices(
  text: string,
  onFile?: (path: string, mimeType: string) => void
): string {
  return text.replace(ANTIGRAVITY_ATTACHMENT_NOTICE, (_, path: string, mimeType: string) => {
    onFile?.(path, mimeType);
    return '';
  });
}

export function wrapAttachmentContext(attachments: readonly AttachmentRef[]): string {
  // A filename must not be able to terminate the private block.
  const metadata = JSON.stringify(attachments).replaceAll('<', '\\u003c');
  return `<orkestra_context>\n<orkestra_attachments>${metadata}</orkestra_attachments>\n</orkestra_context>`;
}

export function replayedImageAttachment(dataUrl: string): AttachmentRef | undefined {
  if (dataUrl.length > MAX_REPLAY_IMAGE_LENGTH) return undefined;
  const mimeType = IMAGE_DATA_URL.exec(dataUrl)?.[1]?.toLowerCase();
  if (!mimeType) return undefined;
  let hash = 2166136261;
  for (let i = 0; i < dataUrl.length; i += 1) {
    hash = Math.imul(hash ^ dataUrl.charCodeAt(i), 16777619);
  }
  return {
    id: `replayed-image:${dataUrl.length}:${(hash >>> 0).toString(16)}`,
    name: 'Image',
    mimeType,
    dataUrl,
  };
}

/** Prefer conversation-owned attachment IDs to data embedded by the provider. */
export function mergeReplayedAttachments(
  existing: readonly AttachmentRef[] = [],
  incoming: readonly AttachmentRef[] = []
): AttachmentRef[] {
  const unique = new Map<string, AttachmentRef>();
  for (const attachment of [...existing, ...incoming]) unique.set(attachment.id, attachment);
  const all = [...unique.values()];
  const stored = all.filter(({ dataUrl }) => !dataUrl);
  return stored.length > 0 ? stored : all;
}

export function readReplayedUserText(rawText: string): {
  text: string;
  attachments: AttachmentRef[];
} {
  const refs: AttachmentRef[] = [];
  for (const match of rawText.matchAll(ATTACHMENT_CONTEXT)) {
    try {
      const parsed = savedAttachmentsSchema.safeParse(JSON.parse(match[1]!));
      if (parsed.success) refs.push(...parsed.data);
    } catch {
      // A provider can truncate private context mid-message.
    }
  }
  const visible = stripHiddenContext(rawText);
  const inline: AttachmentRef[] = [];
  const text = stripAntigravityAttachmentNotices(visible)
    .replace(HOST_ATTACHMENT_NOTICE, (_, metadata: string) => {
      try {
        const saved = JSON.parse(metadata);
        const id =
          typeof saved?.path === 'string' ? OWNED_ATTACHMENT_PATH.exec(saved.path)?.[1] : null;
        const ref = attachmentMetadataSchema.safeParse({
          id,
          name: saved?.name,
          mimeType: saved?.mimeType,
        });
        if (ref.success && z.uuid().safeParse(ref.data.id).success) refs.push(ref.data);
      } catch {
        // Legacy tool instructions can be truncated in provider history.
      }
      return '';
    })
    .replace(IMAGE_LINK, (_, dataUrl: string) => {
      const image = replayedImageAttachment(dataUrl);
      if (image) inline.push(image);
      return '';
    });
  return {
    text: text === visible ? visible : text.trim(),
    attachments: mergeReplayedAttachments(refs, inline),
  };
}
