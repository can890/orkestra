import type { ImageAttachmentMimeType } from '@orkestra/core/runtimes/acp/api/client';
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentMimeType,
  type AttachmentRef,
} from '@orkestra/core/services/attachments/api';
import type { AcpAttachmentUploadInput } from './acp-chat-store';

const UNKNOWN_FILE_MIME_TYPE = 'application/octet-stream';
const supportedAttachmentMimeTypes = new Set<ImageAttachmentMimeType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const attachmentMimeTypeByExtension: Record<string, ImageAttachmentMimeType> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const generalMimeTypeByExtension: Record<string, AttachmentMimeType> = {
  ...attachmentMimeTypeByExtension,
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

export type AcpAttachmentUploader = {
  uploadAttachment(input: AcpAttachmentUploadInput): Promise<AttachmentRef | null>;
};

export type BrowserDroppedFile = Pick<File, 'name' | 'size' | 'stream' | 'type'>;

function toAttachmentMimeTypeValue(value: string): ImageAttachmentMimeType | null {
  const mimeType = value.toLowerCase();
  return supportedAttachmentMimeTypes.has(mimeType as ImageAttachmentMimeType)
    ? (mimeType as ImageAttachmentMimeType)
    : null;
}

export function toAcpImageAttachmentMimeType(
  file: Pick<BrowserDroppedFile, 'name' | 'type'>
): ImageAttachmentMimeType | null {
  const declaredMimeType = toAttachmentMimeTypeValue(file.type);
  if (declaredMimeType) return declaredMimeType;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension ? (attachmentMimeTypeByExtension[extension] ?? null) : null;
}

export function shouldUseAcpImageAttachment(
  file: Pick<BrowserDroppedFile, 'name' | 'type'>
): boolean {
  return toAcpImageAttachmentMimeType(file) !== null;
}

export function droppedFileMimeType(
  file: Pick<BrowserDroppedFile, 'type'> & Partial<Pick<BrowserDroppedFile, 'name'>>
): AttachmentMimeType {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const extension = file.name?.split('.').pop()?.toLowerCase();
  return (extension ? generalMimeTypeByExtension[extension] : undefined) ?? UNKNOWN_FILE_MIME_TYPE;
}

/** Snapshot Desktop-owned bytes into the ACP runtime on the target Host. */
export function uploadDroppedFile(
  uploader: AcpAttachmentUploader,
  file: BrowserDroppedFile,
  mimeType: AttachmentMimeType = droppedFileMimeType(file)
): Promise<AttachmentRef | null> {
  if (file.size > MAX_ATTACHMENT_BYTES)
    return Promise.reject(new Error(`${file.name}: dosya boyutu 250 MB sınırını aşıyor.`));
  return uploader.uploadAttachment({
    source: file.stream(),
    size: file.size,
    mimeType,
    name: file.name || 'attachment',
  });
}
