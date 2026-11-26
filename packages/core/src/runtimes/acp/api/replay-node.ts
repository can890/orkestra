import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { MAX_ATTACHMENT_FILES } from '#services/attachments/api';
import {
  readReplayedUserText,
  replayedImageAttachment,
  stripAntigravityAttachmentNotices,
  wrapAttachmentContext,
} from './models/replayed-user-attachments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^([0-9a-f-]{36})\.(png|jpg|jpeg|gif|webp)$/i;
const MAX_LEGACY_IMAGE_BYTES_PER_MESSAGE = 6 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;

/** Legacy images live in the bridge's private directory for this authenticated session. */
export async function restoreAntigravityReplayAttachments(
  rawText: string,
  stateDirectory: string,
  sessionId: string
): Promise<ReturnType<typeof readReplayedUserText>> {
  const result = readReplayedUserText(rawText);
  if (result.attachments.length || !UUID.test(sessionId)) return result;

  const files = new Map<string, string>();
  stripAntigravityAttachmentNotices(rawText, (path, mimeType) => {
    if (files.size < MAX_ATTACHMENT_FILES) files.set(path, mimeType);
  });
  if (!files.size) return result;

  const sessionDirectory = join(resolve(stateDirectory), 'attachments', sessionId);
  try {
    const root = await realpath(stateDirectory);
    const expectedDirectory = join(root, 'attachments', sessionId);
    if ((await realpath(sessionDirectory)) !== expectedDirectory) return result;

    let remaining = MAX_LEGACY_IMAGE_BYTES_PER_MESSAGE;
    for (const [path, mimeType] of files) {
      const name = basename(path);
      const match = FILE_NAME.exec(name);
      if (!match || !UUID.test(match[1]!) || path !== join(sessionDirectory, name)) continue;
      const extension = match[2]!.toLowerCase() as keyof typeof MIME_BY_EXTENSION;
      if (MIME_BY_EXTENSION[extension] !== mimeType) continue;

      const media = await readLegacyImage(join(expectedDirectory, name), remaining);
      if (!media) continue;
      const attachment = replayedImageAttachment(
        `data:${mimeType};base64,${media.toString('base64')}`
      );
      if (!attachment) continue;
      remaining -= media.length;
      result.attachments.push({ ...attachment, name });
    }
  } catch {
    // The bridge store may be absent when the history was imported from another machine.
  }
  return result;
}

/** Keeps Antigravity's replay as one user chunk, even for attachment-only messages. */
export async function rebuildAntigravityUserChunk(
  rawText: string,
  stateDirectory: string,
  sessionId: string
): Promise<string> {
  const { text, attachments } = await restoreAntigravityReplayAttachments(
    rawText,
    stateDirectory,
    sessionId
  );
  const links = attachments.flatMap(({ dataUrl }) => (dataUrl ? [`[@image](${dataUrl})`] : []));
  const refs = attachments.filter(({ dataUrl }) => !dataUrl);
  return [text, ...links, refs.length ? wrapAttachmentContext(refs) : '']
    .filter(Boolean)
    .join('\n');
}

async function readLegacyImage(path: string, limit: number): Promise<Buffer | null> {
  try {
    if ((await realpath(path)) !== path) return null;
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > limit) return null;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return null;
        offset += bytesRead;
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
