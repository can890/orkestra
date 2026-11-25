import type { StackLayout } from '@core/compose';
import type { MeasureCtx, Measured } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
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
  /** System notice (host-sent user message): padding/gap of the expanded full-text panel. */
  noticeBodyPadX: number;
  noticeBodyPadY: number;
  noticeBodyGap: number;
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
  return fileCount <= 1
    ? Math.min(innerW, SINGLE_FILE_PILL_MAX_W)
    : Math.min(innerW, MULTI_FILE_PILL_W);
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
 * Geometry of a user message row, shared by `measure()` and the renderer so the two can never
 * disagree. Top to bottom the row is:
 *   1. the attachment strip (images/videos, then file chips), right-aligned above the bubble and
 *      as wide as the bubble may grow (`stripH` includes the gap below it; 0 without attachments);
 *   2. the bubble with the message text (`bubbleH`; 0 for an attachment-only message);
 *   3. the meta row (time + actions), always `userFooterH` tall even while hidden.
 */
export type UserMessageGeometry = {
  /** Widest the bubble (and the attachment strip) may be. */
  maxW: number;
  /** Width the text is laid out at inside the bubble. */
  innerW: number;
  stripH: number;
  stack: Measured<StackLayout> | null;
  hasBubble: boolean;
  bubbleH: number;
  totalH: number;
};

export function userMessageGeometry(
  item: { id: string; text: string; attachments?: readonly ChatImageAttachment[] },
  ctx: MeasureCtx,
  vars: MessageVars
): UserMessageGeometry {
  const maxW = userBubbleMaxWidth(ctx.width);
  const innerW = userInnerWidth(ctx.width, vars);
  const stripH = attachStripHeight(item.attachments, maxW, vars);
  const blocks = ctx.caches.parseBlocks(item.id, item.text);
  const stack =
    blocks.length > 0
      ? layoutBlockStack(blocks, { ...ctx, width: innerW }, { isCollapsed: ctx.isCollapsed })
      : null;
  // A message with only attachments has no bubble; an entirely empty one keeps a one-line bubble.
  const hasBubble = stack !== null || stripH === 0;
  const textH = stack ? stack.height : ctx.theme.fonts.body.lineHeight;
  const bubbleH = hasBubble ? textH + 2 * vars.userCardPadY + 2 * vars.cardBorder : 0;
  return {
    maxW,
    innerW,
    stripH,
    stack,
    hasBubble,
    bubbleH,
    totalH: stripH + bubbleH + vars.userFooterH,
  };
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
