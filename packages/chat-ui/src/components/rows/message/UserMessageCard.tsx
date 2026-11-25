import { useCommands } from '@components/contexts/CommandsContext';
import { useTurnState } from '@components/contexts/TurnStateContext';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { CopyButton } from '@components/primitives/CopyButton';
import {
  GenericFileIcon,
  IconPencil,
  IconRewind,
  IconStop,
  ImageOffIcon,
} from '@components/primitives/icons';
import type { RenderCtx } from '@core/define';
import { blockPlainText } from '@core/markdown/plain-text';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createMemo, createResource } from 'solid-js';
import type { ChatMediaGalleryItem } from '@/commands';
import type { ChatImageAttachment, ChatMessage } from '@/model';
import { formatFullMessageTime, formatRelativeMessageTime, useMinuteClock } from './format-time';
import {
  attachmentMediaKind,
  filePillSlotWidth,
  type MessageVars,
  partitionUserAttachments,
  userInnerWidth,
  userMessageGeometry,
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
  cardVars,
  userActionBar,
  userActionBtn,
  userActionReveal,
  userCardGroup,
  userRowContainer,
  userTimestamp,
} from './user-message.css';
import { actionTooltipEnd } from '@components/primitives/action-tooltip.css';

/**
 * Kullanıcının kendi mesajı, Claude uygulamasındaki gibi: sağa yaslı, metni saran, kenarlıksız,
 * yumuşak köşeli balon; altında sağa yaslı soluk bir satırda göreli zaman ve gerçekten var olan
 * eylemler (geri sar, yeniden yaz, kopyala; host bağladıysa durdur). Mesaj hiçbir zaman
 * katlanmaz/açılmaz ve hiçbir şey sabitlenmez. Yükseklik `userMessageGeometry` ile `measure()`
 * ile aynı hesaptan gelir.
 */
export function UserMessageCard(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const commands = useCommands();
  const turn = useTurnState();
  const now = useMinuteClock();
  const mCtx = () => props.ctx.measureCtx?.();

  const isCurrent = () => turn.currentMessageId() === props.data.id;
  const showStop = () =>
    isCurrent() && turn.turnStatus() === 'generating' && commands().onStop !== undefined;

  const styleVars = () => ({
    userCardPadX: props.vars.userCardPadX,
    userCardPadY: props.vars.userCardPadY,
    cardBorder: props.vars.cardBorder,
    attachThumb: props.vars.attachThumb,
    attachGap: props.vars.attachGap,
  });

  const geometry = createMemo(() => {
    const ctx = mCtx();
    return ctx ? userMessageGeometry(props.data, ctx, props.vars) : null;
  });

  // Ölçüm bağlamı henüz yokken yer tutucu: tek satırlık balon.
  const bubbleH = () =>
    geometry()?.bubbleH ?? 24 + 2 * props.vars.userCardPadY + 2 * props.vars.cardBorder;
  const hasBubble = () => geometry()?.hasBubble ?? true;

  /** Balon metni sarar: en uzun satır kadar geniş, en fazla `maxW`. */
  const bubbleWidth = createMemo<number | undefined>(() => {
    const g = geometry();
    if (!g) return undefined;
    const contentW = g.stack ? g.stack.width : 0;
    const innerW = Math.min(g.innerW, Math.ceil(Math.max(contentW, 16)) + 2);
    return Math.min(g.maxW, innerW + 2 * props.vars.userCardPadX + 2 * props.vars.cardBorder);
  });

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    return ctx.caches.parseBlocks(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };

  const relativeTime = () => formatRelativeMessageTime(props.data.createdAt, now());
  const fullTime = () => formatFullMessageTime(props.data.createdAt) ?? undefined;
  const partitionedAttachments = createMemo(() => partitionUserAttachments(props.data.attachments));
  const stripW = () => geometry()?.maxW;
  const pillSlotW = createMemo(() => {
    const g = geometry();
    return filePillSlotWidth(partitionedAttachments().files.length, g ? g.maxW : 320);
  });

  return (
    <div data-user-card={props.data.id} class={`${userRowContainer} ${userCardGroup}`}>
      <div class={srOnly}>{plainText()}</div>
      <Show when={props.data.attachments?.length}>
        <div
          class={attachmentStrip}
          style={{
            ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: 0 })),
            ...(stripW() !== undefined ? { width: `${stripW()}px` } : {}),
          }}
        >
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
      <Show when={hasBubble()}>
        <div
          data-user-bubble={props.data.id}
          class={card}
          style={{
            ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: bubbleH() })),
            ...(bubbleWidth() !== undefined ? { width: `${bubbleWidth()}px` } : {}),
          }}
        >
          <Show when={geometry()?.stack}>{(s) => <BlockStackView node={s()} />}</Show>
        </div>
      </Show>
      <div class={userActionBar} style={{ height: `${props.vars.userFooterH}px` }}>
        <Show when={relativeTime()}>
          {(time) => (
            <time
              class={userTimestamp}
              dateTime={new Date(props.data.createdAt ?? 0).toISOString()}
              title={fullTime()}
            >
              {time()}
            </time>
          )}
        </Show>
        <Show when={showStop()}>
          <button
            type="button"
            class={`${userActionBtn} ${actionTooltipEnd}`}
            aria-label="Durdur"
            data-tooltip="Durdur"
            onClick={(e) => {
              e.stopPropagation();
              commands().onStop?.({ itemId: props.data.id });
            }}
          >
            <IconStop />
          </button>
        </Show>
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
        <Show when={props.data.text.trim()}>
          <CopyButton
            text={props.data.text}
            variant="icon"
            label="Kopyala"
            tooltipAlign="end"
            class={userActionReveal}
          />
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
