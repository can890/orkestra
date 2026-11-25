/**
 * PinnedUserMessage — üst kenara sabitlenen kullanıcı isteğinin tek satırlık hap görünümü.
 *
 * Aşağı kaydırınca etkin turun isteği üstte kalır. Eskiden satır içi kartın tam kopyası (ekler,
 * birden çok satır) gösteriliyordu; bu büyük, kare bir kutu oluşturup transkriptin üstünü
 * kapatıyordu. Artık isteğin ilk satırı sağa yaslı, yuvarlak bir hapta tek satır olarak görünür;
 * ekler yalnızca küçük bir sayaçla belirtilir. Tıklayınca transkript isteğin kendisine kayar.
 *
 * Yükseklik sabittir (`PINNED_USER_PILL_HEIGHT`); ChatRoot, bir sonraki istek yaklaşırken hapı
 * yukarı itmek için bu değeri kullanır.
 */

import type { ChatMessage } from '@/model';
import { pinnedPromptLine } from './pinned-prompt-line';
import {
  pinnedPill,
  pinnedPillAttachments,
  pinnedPillRow,
  pinnedPillText,
  pinnedScrollFade,
} from './user-message.css';

/** Hap satırının toplam yüksekliği (üst boşluk + hap + alt boşluk), piksel. */
export const PINNED_USER_PILL_HEIGHT = 52;

export function PinnedUserMessage(props: { item: ChatMessage; onActivate?: () => void }) {
  const line = () => pinnedPromptLine(props.item.text);
  const attachmentCount = () => props.item.attachments?.length ?? 0;
  const label = () => line() || (attachmentCount() > 0 ? 'Ek' : '');

  return (
    <>
      <div class={pinnedPillRow} style={{ height: `${PINNED_USER_PILL_HEIGHT}px` }}>
        <button
          type="button"
          class={pinnedPill}
          title={props.item.text}
          onClick={() => props.onActivate?.()}
        >
          {attachmentCount() > 0 ? (
            <span class={pinnedPillAttachments} aria-label={`${attachmentCount()} ek`}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <rect
                  x="2"
                  y="3"
                  width="12"
                  height="10"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                />
                <circle cx="6" cy="7" r="1.3" fill="currentColor" />
                <path
                  d="M3.5 12l3.2-3.2 2.3 2.3 1.6-1.6 2.4 2.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                />
              </svg>
              {attachmentCount()}
            </span>
          ) : null}
          <span class={pinnedPillText}>{label()}</span>
        </button>
      </div>
      {/* Altta kayan satırların hapın altından geçtiğini belirten ince geçiş. */}
      <div class={pinnedScrollFade} aria-hidden="true" />
    </>
  );
}
