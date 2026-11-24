/**
 * CopyButton — shared copy-to-clipboard button.
 *
 * Two variants:
 *   'inline'  — used in the message footer: text label + icon, appears on group-hover.
 *   'overlay' — used in code blocks: icon-only, absolute positioned top-right.
 *
 * State is managed by createClipboard (Lane B — never touches measure).
 */

import { Show } from 'solid-js';
import { IconCheck, IconCopy } from './icons';
import { createClipboard } from './use-clipboard';
import { copyButtonIcon, copyButtonInline, copyButtonOverlay } from './copy-button.css';

export type CopyButtonProps = {
  text: string;
  variant: 'inline' | 'overlay' | 'icon';
  /** aria-label / tooltip prefix. Defaults to 'Kopyala'. */
  label?: string;
  class?: string;
};

export function CopyButton(props: CopyButtonProps) {
  const { copied, copy } = createClipboard();
  const label = () => props.label ?? 'Kopyala';
  const ariaLabel = () => (copied() ? 'Kopyalandı' : label());

  if (props.variant === 'overlay') {
    return (
      <button
        type="button"
        class={props.class ? `${copyButtonOverlay} ${props.class}` : copyButtonOverlay}
        aria-label={ariaLabel()}
        title={ariaLabel()}
        onClick={() => copy(props.text)}
      >
        <Show when={copied()} fallback={<IconCopy />}>
          <IconCheck />
        </Show>
      </button>
    );
  }

  if (props.variant === 'icon') {
    return (
      <button
        type="button"
        class={props.class ? `${copyButtonIcon} ${props.class}` : copyButtonIcon}
        aria-label={ariaLabel()}
        title={ariaLabel()}
        onClick={(e) => {
          e.stopPropagation();
          copy(props.text);
        }}
      >
        <Show when={copied()} fallback={<IconCopy />}>
          <IconCheck />
        </Show>
      </button>
    );
  }

  return (
    <button
      type="button"
      class={props.class ? `${copyButtonInline} ${props.class}` : copyButtonInline}
      aria-label={ariaLabel()}
      title={ariaLabel()}
      onClick={() => copy(props.text)}
    >
      <Show when={copied()} fallback={<IconCopy />}>
        <IconCheck />
      </Show>
      <span>{copied() ? 'Kopyalandı' : 'Kopyala'}</span>
    </button>
  );
}
