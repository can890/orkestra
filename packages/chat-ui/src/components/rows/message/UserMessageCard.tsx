import { useCommands } from '@components/contexts/CommandsContext';
import { useTurnState } from '@components/contexts/TurnStateContext';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { clipTrackedHeight, isCardAnimating } from '@components/primitives/card-clip';
import { CopyButton } from '@components/primitives/CopyButton';
import {
  GenericFileIcon,
  IconPencil,
  IconRewind,
  IconStop,
  ImageOffIcon,
} from '@components/primitives/icons';
import type { StackLayout } from '@core/compose';
import type { Measured, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import { blockPlainText } from '@core/markdown/plain-text';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createMemo, createResource } from 'solid-js';
import type { ChatMediaGalleryItem } from '@/commands';
import type { ChatImageAttachment, ChatMessage } from '@/model';
import { formatMessageTime } from './format-time';
import {
  attachStripHeight,
  attachStripWidth,
  attachmentMediaKind,
  filePillSlotWidth,
  type MessageVars,
  partitionUserAttachments,
  userBubbleMaxWidth,
  userInnerWidth,
} from './metrics';
import { srOnly } from './message.css';
import {
  attachFileName,
  attachFilePill,
  attachmentStrip,
  attachPlaceholder,
  attachRow,
  attachThumb,
  attachThumbBtn,
  attachVideoBadge,
  card,
  cardFadeOverlay,
  cardRoot,
  cardVars,
  stopButtonOverlay,
  userActionBar,
  userActionBtn,
  userActionReveal,
  userCardGroup,
  userRowContainer,
  userTimestamp,
} from './user-message.css';
import { actionTooltipEnd } from '@components/primitives/action-tooltip.css';

export function UserMessageCard(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const commands = useCommands();
  const turn = useTurnState();
  const mCtx = () => props.ctx.measureCtx?.();

  const isCurrent = () => turn.currentMessageId() === props.data.id;
  const showStop = () => isCurrent() && turn.turnStatus() === 'generating';

  const styleVars = () => ({
    userCardPadX: props.vars.userCardPadX,
    userCardPadY: props.vars.userCardPadY,
    cardBorder: props.vars.cardBorder,
    attachThumb: props.vars.attachThumb,
    attachGap: props.vars.attachGap,
  });

  const innerWidth = () => {
    const c = mCtx();
    return c ? userInnerWidth(c.width, props.vars) : 0;
  };

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = ctx.caches.parseBlocks(props.data.id, props.data.text);
    if (blocks.length === 0) return null;
    const innerCtx = { ...ctx, width: innerWidth() };
    return layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
  });

  const stripHeight = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return 0;
    const innerW = userInnerWidth(ctx.width, props.vars);
    return attachStripHeight(props.data.attachments, innerW, props.vars);
  });

  const fullContentH = createMemo(() => {
    const ctx = mCtx();
    // Ölçüm bağlamı henüz yokken yer tutucu: tek satırlık kart (sınır değeri kullanılamaz).
    if (!ctx) return 2 * props.vars.userCardPadY + 2 * props.vars.cardBorder + 24;
    const innerW = userInnerWidth(ctx.width, props.vars);
    const aH = stripHeight();
    const blocks = ctx.caches.parseBlocks(props.data.id, props.data.text);
    if (blocks.length === 0) {
      return (
        aH +
        ctx.theme.fonts.body.lineHeight +
        2 * props.vars.userCardPadY +
        2 * props.vars.cardBorder
      );
    }
    const innerCtx = { ...ctx, width: innerW };
    const s = layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
    return aH + s.height + 2 * props.vars.userCardPadY + 2 * props.vars.cardBorder;
  });

  const bubbleWidth = createMemo<number | undefined>(() => {
    const ctx = mCtx();
    if (!ctx) return undefined;
    const maxW = userBubbleMaxWidth(ctx.width);
    const maxInnerW = userInnerWidth(ctx.width, props.vars);
    const attachW = attachStripWidth(props.data.attachments, maxInnerW, props.vars);
    const s = stack();
    const contentW = s ? s.width : 0;
    const fallbackTextW =
      contentW > 0 || !props.data.text.trim()
        ? 0
        : Math.min(maxInnerW, Math.max(40, props.data.text.trim().length * 7));
    const stopReserve = showStop() ? 22 : 0;
    const rawInnerW =
      Math.max(attachW, contentW, fallbackTextW, props.data.text.trim() ? 16 : 32) + stopReserve;
    const clampedInnerW = Math.min(maxInnerW, Math.ceil(rawInnerW) + 2);
    return Math.min(maxW, clampedInnerW + 2 * props.vars.userCardPadX + 2 * props.vars.cardBorder);
  });

  const isExpanded = () => mCtx()?.expandedId === props.data.id;
  const maxH = () => {
    const aH = stripHeight();
    const base = isExpanded() ? props.vars.expandedMaxH : props.vars.collapsedMaxH;
    if (aH <= 0) return base;
    return Math.max(base, aH + (isExpanded() ? 120 : 64));
  };
  const clampedH = () => Math.min(fullContentH(), maxH());
  const isOverflowing = () => fullContentH() > maxH();

  // Track the animated clip edge during expand/collapse tween so the bottom
  // border and rounded corners are never hidden by the UnitRow overflow clip.
  const cardH = clipTrackedHeight(props.ctx, clampedH);

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    return ctx.caches.parseBlocks(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };

  const formattedTime = () => formatMessageTime(props.data.createdAt);
  const partitionedAttachments = createMemo(() => partitionUserAttachments(props.data.attachments));
  const pillSlotW = createMemo(() => {
    const ctx = mCtx();
    const innerW = ctx ? userInnerWidth(ctx.width, props.vars) : 320;
    return filePillSlotWidth(partitionedAttachments().files.length, innerW);
  });

  return (
    <div class={`${userRowContainer} ${userCardGroup}`}>
      <div
        data-user-card={props.data.id}
        class={`${card({ state: isOverflowing() && !isExpanded() ? 'overflowing' : 'static', current: showStop() })} ${cardRoot}`}
        style={{
          ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: cardH() })),
          ...(bubbleWidth() !== undefined ? { width: `${bubbleWidth()}px` } : {}),
          // Force overflow:hidden while the UnitRow tween is in flight to avoid
          // a transient scrollbar mid-animation; restore auto only when expanded
          // at rest (so the user can scroll long messages).
          'overflow-y': isCardAnimating(props.ctx) || !isExpanded() ? 'hidden' : 'auto',
          cursor: !isExpanded() && isOverflowing() ? 'pointer' : 'default',
        }}
      >
        <div class={srOnly}>{plainText()}</div>
        <Show when={props.data.attachments?.length}>
          <div class={attachmentStrip}>
            <Show when={partitionedAttachments().media.length > 0}>
              <div class={attachRow}>
                <For each={partitionedAttachments().media}>
                  {(att, index) => (
                    <AttachmentThumb
                      attachment={att}
                      itemId={props.data.id}
                      index={index()}
                      mediaList={partitionedAttachments().media}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={partitionedAttachments().files.length > 0}>
              <div class={attachRow}>
                <For each={partitionedAttachments().files}>
                  {(att) => <AttachmentFilePill attachment={att} width={pillSlotW()} />}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
        <Show when={!isExpanded() && isOverflowing()}>
          <div class={cardFadeOverlay} />
        </Show>
        <Show when={showStop()}>
          <button
            type="button"
            class={stopButtonOverlay}
            aria-label="Durdur"
            title="Durdur"
            onClick={(e) => {
              e.stopPropagation();
              commands().onStop?.({ itemId: props.data.id });
            }}
          >
            <IconStop />
          </button>
        </Show>
      </div>
      <div class={userActionBar} style={{ height: `${props.vars.userFooterH}px` }}>
        <Show when={formattedTime()}>{(time) => <span class={userTimestamp}>{time()}</span>}</Show>
        <Show when={commands().onEditMessage}>
          {(onEdit) => (
            <button
              type="button"
              class={`${userActionBtn} ${actionTooltipEnd}`}
              aria-label="Yeniden yaz"
              data-tooltip="Yeniden yaz"
              onClick={(e) => {
                e.stopPropagation();
                onEdit()({ itemId: props.data.id, text: props.data.text });
              }}
            >
              <IconPencil />
            </button>
          )}
        </Show>
        <CopyButton
          text={props.data.text}
          variant="icon"
          label="Kopyala"
          tooltipAlign="end"
          class={userActionReveal}
        />
        <Show when={commands().onRewind ? props.data.promptId : undefined}>
          {(promptId) => (
            <button
              type="button"
              class={`${userActionBtn} ${actionTooltipEnd}`}
              aria-label="Bu mesaja geri sar"
              data-tooltip="Bu mesaja geri sar"
              onClick={(e) => {
                e.stopPropagation();
                commands().onRewind?.({ itemId: props.data.id, promptId: promptId() });
              }}
            >
              <IconRewind />
            </button>
          )}
        </Show>
      </div>
    </div>
  );
}

function AttachmentThumb(props: {
  attachment: ChatImageAttachment;
  itemId: string;
  index: number;
  mediaList: readonly ChatImageAttachment[];
}) {
  const commands = useCommands();
  const kind = () => attachmentMediaKind(props.attachment);
  const isVisual = () => kind() === 'image' || kind() === 'video';
  const [resolvedDataUrl] = createResource(
    () => (props.attachment.dataUrl || !isVisual() ? null : props.attachment.id),
    async () => commands().resolveAttachment?.(props.attachment) ?? null
  );
  const dataUrl = () => props.attachment.dataUrl ?? resolvedDataUrl() ?? undefined;

  const openLightbox = (src?: string) => {
    const gallery: ChatMediaGalleryItem[] = props.mediaList.map((item, idx) => {
      const k = attachmentMediaKind(item) === 'video' ? 'video' : 'image';
      return {
        id: item.id,
        src: idx === props.index ? (src ?? item.dataUrl) : item.dataUrl,
        alt: item.name,
        kind: k,
        mimeType: item.mimeType,
        attachment: idx === props.index ? { ...item, dataUrl: src ?? item.dataUrl } : item,
      };
    });
    commands().onViewImage?.({
      attachment: { ...props.attachment, dataUrl: src },
      itemId: props.itemId,
      source: 'user-message',
      kind: kind() === 'video' ? 'video' : 'image',
      gallery,
      index: props.index,
    });
  };

  return (
    <Show
      when={dataUrl()}
      fallback={
        <Show
          when={kind() === 'video'}
          fallback={
            <div title={props.attachment.name} class={attachPlaceholder}>
              <ImageOffIcon />
            </div>
          }
        >
          <button
            type="button"
            class={attachThumbBtn}
            aria-label={`View video: ${props.attachment.name}`}
            onClick={(e) => {
              e.stopPropagation();
              openLightbox(undefined);
            }}
          >
            <div class={attachPlaceholder}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4.2 2.8a.6.6 0 0 1 .9-.52l8.2 5.2a.6.6 0 0 1 0 1.04l-8.2 5.2a.6.6 0 0 1-.9-.52V2.8Z" />
              </svg>
            </div>
          </button>
        </Show>
      }
    >
      {(src) => (
        <button
          type="button"
          class={attachThumbBtn}
          aria-label={`View ${kind() === 'video' ? 'video' : 'image'}: ${props.attachment.name}`}
          onClick={(e) => {
            e.stopPropagation();
            openLightbox(src());
          }}
        >
          <Show
            when={kind() === 'video'}
            fallback={<img src={src()} alt={props.attachment.name} class={attachThumb} />}
          >
            <video src={src()} muted playsinline preload="metadata" class={attachThumb} />
            <span class={attachVideoBadge}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4.2 2.8a.6.6 0 0 1 .9-.52l8.2 5.2a.6.6 0 0 1 0 1.04l-8.2 5.2a.6.6 0 0 1-.9-.52V2.8Z" />
              </svg>
            </span>
          </Show>
        </button>
      )}
    </Show>
  );
}

function AttachmentFilePill(props: { attachment: ChatImageAttachment; width: number }) {
  return (
    <div class={attachFilePill} title={props.attachment.name} style={{ width: `${props.width}px` }}>
      <GenericFileIcon />
      <span class={attachFileName}>{props.attachment.name}</span>
    </div>
  );
}

export { userInnerWidth };
export type { MessageVars };
