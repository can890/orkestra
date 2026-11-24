import type { ChatImageAttachment } from '@/model';

export const USER_BUBBLE_MAX_RATIO = 0.78;
export const ATTACH_FILE_PILL_H = 32;
const SINGLE_FILE_PILL_MAX_W = 220;
const MULTI_FILE_PILL_W = 168;

export type MessageVars = {
  cardBorder: number;
  collapsedMaxH: number;
  expandedMaxH: number;
  userCardPadX: number;
  userCardPadY: number;
  attachThumb: number;
  attachGap: number;
  footerH: number;
  userFooterH: number;
};

/** Subset of MessageVars projected into CSS via the VE contract. */
export type MessageStyleVars = {
  userCardPadX: number;
  userCardPadY: number;
  cardBorder: number;
  attachThumb: number;
  attachGap: number;
};

export function attachmentMediaKind(
  attachment: Pick<ChatImageAttachment, 'mimeType' | 'name'>
): 'image' | 'video' | 'audio' | 'file' {
  const mime = (attachment.mimeType ?? '').toLowerCase();
  const ext = (attachment.name.split('.').pop() ?? '').toLowerCase();
  if (
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
  ) {
    return 'image';
  }
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) {
    return 'video';
  }
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
    return 'audio';
  }
  return 'file';
}

export function partitionUserAttachments(attachments: readonly ChatImageAttachment[] | undefined) {
  const media: ChatImageAttachment[] = [];
  const files: ChatImageAttachment[] = [];
  for (const att of attachments ?? []) {
    const k = attachmentMediaKind(att);
    if (k === 'image' || k === 'video') {
      media.push(att);
    } else {
      files.push(att);
    }
  }
  return { media, files };
}

export function filePillSlotWidth(fileCount: number, innerW: number): number {
  return fileCount <= 1 ? Math.min(innerW, SINGLE_FILE_PILL_MAX_W) : Math.min(innerW, MULTI_FILE_PILL_W);
}

/** Maximum width (px) allowed for a right-aligned T3-style user bubble. */
export function userBubbleMaxWidth(ctxWidth: number): number {
  if (ctxWidth < 320) return Math.max(1, ctxWidth);
  return Math.max(1, Math.min(ctxWidth, Math.floor(ctxWidth * USER_BUBBLE_MAX_RATIO)));
}

/** Available width for block layout inside the user bubble. */
export function userInnerWidth(ctxWidth: number, vars: MessageVars): number {
  return Math.max(1, userBubbleMaxWidth(ctxWidth) - 2 * vars.userCardPadX - 2 * vars.cardBorder);
}

/**
 * Total height consumed by the attachment strip (including the bottom gap that
 * separates it from the text block). Returns 0 when there are no attachments.
 */
export function attachStripHeight(
  attachments: number | readonly ChatImageAttachment[] | undefined,
  innerW: number,
  vars: MessageVars
): number {
  const { attachThumb: thumb, attachGap: gap } = vars;
  if (typeof attachments === 'number') {
    if (attachments <= 0) return 0;
    const perRow = Math.max(1, Math.floor((innerW + gap) / (thumb + gap)));
    const rows = Math.ceil(attachments / perRow);
    return rows * thumb + (rows - 1) * gap + gap;
  }
  if (!attachments || attachments.length === 0) return 0;

  const { media, files } = partitionUserAttachments(attachments);
  let total = 0;

  if (media.length > 0) {
    const perRow = Math.max(1, Math.floor((innerW + gap) / (thumb + gap)));
    const rows = Math.ceil(media.length / perRow);
    total += rows * thumb + Math.max(0, rows - 1) * gap;
  }

  if (files.length > 0) {
    const pillW = filePillSlotWidth(files.length, innerW);
    const perRow = Math.max(1, Math.floor((innerW + gap) / (pillW + gap)));
    const rows = Math.ceil(files.length / perRow);
    if (total > 0) total += gap;
    total += rows * ATTACH_FILE_PILL_H + Math.max(0, rows - 1) * gap;
  }

  return total > 0 ? total + gap : 0;
}

export function attachStripWidth(
  attachments: readonly ChatImageAttachment[] | undefined,
  innerW: number,
  vars: MessageVars
): number {
  if (!attachments || attachments.length === 0) return 0;
  const { attachThumb: thumb, attachGap: gap } = vars;
  const { media, files } = partitionUserAttachments(attachments);
  const mediaW =
    media.length > 0
      ? Math.min(innerW, media.length * thumb + Math.max(0, media.length - 1) * gap)
      : 0;
  const pillW = filePillSlotWidth(files.length, innerW);
  const filesW =
    files.length > 0
      ? Math.min(innerW, files.length * pillW + Math.max(0, files.length - 1) * gap)
      : 0;
  return Math.max(mediaW, filesW);
}
