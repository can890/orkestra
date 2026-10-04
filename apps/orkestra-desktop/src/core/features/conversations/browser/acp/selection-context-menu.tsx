import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

type MenuState = {
  x: number;
  y: number;
  /** Kullanicinin sectigi metin (bos olabilir). */
  selection: string;
  /** Sag tiklanan mesaj blogunun duz metni. */
  messageText: string;
  /** Ayni blogun markdown'a serilestirilmis hali. */
  messageMarkdown: string;
};

const MESSAGE_SELECTORS = [
  '[data-unit-id]',
  '[data-message-id]',
  '[data-testid="chat-message"]',
  '[role="listitem"]',
  'article',
  'li',
].join(',');

/** Mesaj DOM'unu kabaca markdown'a cevirir (baslik, liste, kod, link, vurgu). */
function htmlToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return '';

  const tag = el.tagName.toLowerCase();
  const children = () => Array.from(el.childNodes).map(htmlToMarkdown).join('');

  switch (tag) {
    case 'script':
    case 'style':
    case 'svg':
      return '';
    case 'br':
      return '\n';
    case 'h1':
      return `\n# ${children().trim()}\n`;
    case 'h2':
      return `\n## ${children().trim()}\n`;
    case 'h3':
      return `\n### ${children().trim()}\n`;
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n#### ${children().trim()}\n`;
    case 'strong':
    case 'b':
      return `**${children().trim()}**`;
    case 'em':
    case 'i':
      return `*${children().trim()}*`;
    case 'del':
    case 's':
      return `~~${children().trim()}~~`;
    case 'a': {
      const href = el.getAttribute('href');
      const text = children().trim();
      return href ? `[${text}](${href})` : text;
    }
    case 'pre': {
      const codeEl = el.querySelector('code');
      const lang = codeEl?.className.match(/language-([\w-]+)/)?.[1] ?? '';
      const body = (codeEl?.textContent ?? el.textContent ?? '').replace(/\n+$/, '');
      return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    }
    case 'code':
      // pre > code zaten yukarida islendi; buraya yalnizca satir ici kod duser.
      return el.closest('pre') ? (el.textContent ?? '') : `\`${el.textContent ?? ''}\``;
    case 'li': {
      const parentTag = el.parentElement?.tagName.toLowerCase();
      const marker =
        parentTag === 'ol'
          ? `${Array.from(el.parentElement?.children ?? []).indexOf(el) + 1}. `
          : '- ';
      return `${marker}${children().trim()}\n`;
    }
    case 'ul':
    case 'ol':
      return `\n${children()}`;
    case 'blockquote':
      return `\n${children()
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n`;
    case 'p':
    case 'div':
    case 'section':
      return `${children()}\n`;
    default:
      return children();
  }
}

function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

/** Metni alinti blogu olarak bicimlendirir. */
function asQuote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

async function copy(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Pano erisimi reddedilirse sessizce vazgec.
  }
}

export function useSelectionContextMenu(options: { onAddToDraft: (text: string) => void }) {
  const { onAddToDraft } = options;
  const [menu, setMenu] = useState<MenuState | null>(null);

  const close = useCallback(() => setMenu(null), []);

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Girdi alanlarinda sistemin kendi menusu kalsin.
    if (target.closest('input, textarea, [contenteditable="true"]')) return;

    const selection = (window.getSelection()?.toString() ?? '').trim();
    const container = target.closest<HTMLElement>(MESSAGE_SELECTORS) ?? null;
    const messageText = (container?.innerText ?? '').trim();
    if (!selection && !messageText) return;

    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      selection,
      messageText,
      messageMarkdown: container ? tidy(htmlToMarkdown(container)) : '',
    });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onAway = () => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onAway);
    window.addEventListener('wheel', onAway, { passive: true });
    window.addEventListener('resize', onAway);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onAway);
      window.removeEventListener('wheel', onAway);
      window.removeEventListener('resize', onAway);
    };
  }, [menu, close]);

  const items = useMemo(() => {
    if (!menu) return [];
    const { selection, messageText, messageMarkdown } = menu;
    return [
      {
        id: 'copy',
        label: 'Kopyala',
        hint: '⌘C',
        enabled: selection.length > 0,
        run: () => copy(selection),
      },
      {
        id: 'add-context',
        label: 'Seçimi bağlam olarak ekle',
        hint: '⇧⌘L',
        enabled: selection.length > 0,
        run: () => onAddToDraft(asQuote(selection)),
      },
      {
        id: 'reply',
        label: 'Alıntılayarak yanıtla',
        enabled: (selection || messageText).length > 0,
        run: () => onAddToDraft(`${asQuote(selection || messageText)}\n\n`),
      },
      { id: 'sep', label: '-', enabled: false, run: () => {} },
      {
        id: 'copy-message',
        label: 'Mesajı kopyala',
        enabled: messageText.length > 0,
        run: () => copy(messageText),
      },
      {
        id: 'copy-message-md',
        label: 'Mesajı Markdown olarak kopyala',
        enabled: messageMarkdown.length > 0,
        run: () => copy(messageMarkdown),
      },
    ];
  }, [menu, onAddToDraft]);

  const element = menu
    ? createPortal(
        <div
          className="fixed z-[1000] min-w-56 rounded-md border border-(--em-border) bg-(--em-surface) py-1 text-sm shadow-lg"
          style={{
            left: Math.min(menu.x, window.innerWidth - 260),
            top: Math.min(menu.y, window.innerHeight - 220),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
        >
          {items.map((item) =>
            item.label === '-' ? (
              <div key={item.id} className="my-1 h-px bg-(--em-border)" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={!item.enabled}
                className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-foreground hover:bg-(--em-surface-hover) disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => {
                  item.run();
                  close();
                }}
              >
                <span>{item.label}</span>
                {item.hint ? (
                  <span className="text-xs text-foreground-muted">{item.hint}</span>
                ) : null}
              </button>
            )
          )}
        </div>,
        document.body
      )
    : null;

  return { onContextMenu, element };
}
