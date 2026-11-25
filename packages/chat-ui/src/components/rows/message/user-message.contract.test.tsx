/**
 * Kullanıcı mesajı balonu için tarayıcı sözleşme testleri (Claude uygulaması görünümü).
 *
 * - measure() çizilen satırla piksel piksel aynı olmalı (tek satır, çok satır, en geniş hâlde
 *   kaydırılmış, dar bölme, ekler, yalnızca ek, uzun kesintisiz metin, kod bloğu).
 * - Balon sağa yaslı, metni sarar, kenarlıksız, gölgesiz, yumuşak köşeli ve dolgulu.
 * - Altındaki zaman + eylem satırı gizliyken de yer kaplar; yalnızca gerçekten bağlı eylemler çizilir.
 */

import { CommandsContext } from '@components/contexts/CommandsContext';
import { TurnStateContext, type TurnState } from '@components/contexts/TurnStateContext';
import { createChatCaches } from '@core/caches';
import type { MeasureCtx, RenderCtx } from '@core/define';
import { DEFAULT_THEME } from '@core/theme';
import type { UnitDef } from '@core/units';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatCommands } from '@/commands';
import type { ChatImageAttachment, ChatMessage } from '@/model';
import { makeContractCtx, renderAndMeasureUnit } from '@/tests/contract';
import { messageUnitDef } from './message.def';
import { USER_BUBBLE_MAX_RATIO } from './metrics';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function user(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { kind: 'message', id, seq: 0, role: 'user', text, ...extra } as ChatMessage;
}

function images(n: number): ChatImageAttachment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `img-${i}`,
    name: `ekran-${i}.png`,
    mimeType: 'image/png',
    dataUrl: PIXEL,
  }));
}

const files: ChatImageAttachment[] = [
  { id: 'f-1', name: 'rapor.pdf', mimeType: 'application/pdf' },
  { id: 'f-2', name: 'notlar-cok-uzun-bir-dosya-adi.txt', mimeType: 'text/plain' },
];

const LONG_PARAGRAPH = Array.from(
  { length: 12 },
  () => 'kanka spiderman 3 vardı içeride şuan yok getirsene onu geri'
).join(' ');

const FENCE = '`'.repeat(3);
const CODE_MESSAGE = [
  'bak:',
  '',
  `${FENCE}ts`,
  `const x = '${'uzun-bir-satir-'.repeat(20)}';`,
  FENCE,
].join('\n');

const CASES: { name: string; width: number; item: ChatMessage }[] = [
  { name: 'one line', width: 720, item: user('one', 'kanka spiderman 3 vardı içeride') },
  {
    name: 'multi line',
    width: 720,
    item: user('multi', 'ilk satır\n\nikinci paragraf\n\n- madde bir\n- madde iki'),
  },
  { name: 'wrapped at max width', width: 720, item: user('wrap', LONG_PARAGRAPH) },
  { name: 'narrow pane (320 px)', width: 320, item: user('narrow', LONG_PARAGRAPH) },
  { name: 'very narrow pane (280 px)', width: 280, item: user('tiny', LONG_PARAGRAPH) },
  {
    name: 'long unbroken string',
    width: 360,
    item: user('unbroken', `https://example.com/${'a'.repeat(240)}`),
  },
  {
    name: 'code block',
    width: 420,
    item: user('code', CODE_MESSAGE),
  },
  {
    name: 'images + files + text',
    width: 720,
    item: user('attach', 'şu ekranlara bak', { attachments: [...images(3), ...files] }),
  },
  {
    name: 'many images wrap in a narrow pane',
    width: 320,
    item: user('attach-narrow', 'çok resim', { attachments: images(7) }),
  },
  {
    name: 'attachments only',
    width: 720,
    item: user('attach-only', '', { attachments: images(2) }),
  },
];

async function mountUser(
  item: ChatMessage,
  width: number,
  commands: ChatCommands = {},
  turn: TurnState = { currentMessageId: () => null, turnStatus: () => 'done' }
): Promise<{ host: HTMLElement; row: HTMLElement; ctx: MeasureCtx; dispose: () => void }> {
  const ctx: MeasureCtx = {
    theme: DEFAULT_THEME,
    width,
    isCollapsed: () => false,
    expanded: () => false,
    caches: createChatCaches(),
  };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed: ctx.isCollapsed },
    measureCtx: () => ctx,
  };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  const Comp = messageUnitDef.Render as (p: Record<string, unknown>) => JSX.Element;
  const dispose = render(
    () => (
      <TurnStateContext.Provider value={turn}>
        <CommandsContext.Provider value={() => commands}>
          <Comp data={item} ctx={renderCtx} vars={messageUnitDef.vars} />
        </CommandsContext.Provider>
      </TurnStateContext.Provider>
    ),
    host
  );
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  return {
    host,
    row: host.firstElementChild as HTMLElement,
    ctx,
    dispose: () => {
      dispose();
      host.remove();
    },
  };
}

describe('user message bubble: measure() == render', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const ctx = makeContractCtx({ width: c.width });
      const { computed, dom } = await renderAndMeasureUnit(
        messageUnitDef as unknown as UnitDef<ChatMessage, Record<string, number>>,
        c.item,
        ctx
      );
      expect(dom).toBeGreaterThan(0);
      expect(computed).toBe(dom);
    });
  }
});

describe('user message bubble: look', () => {
  it('is a right-aligned, borderless, shadowless, rounded bubble that hugs short text', async () => {
    const m = await mountUser(user('short', 'kısa mesaj'), 720);
    try {
      const bubble = m.row.querySelector<HTMLElement>('[data-user-bubble="short"]')!;
      expect(bubble).not.toBeNull();
      const cs = getComputedStyle(bubble);
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(cs.borderTopColor).toBe('rgba(0, 0, 0, 0)');
      expect(cs.boxShadow).toBe('none');
      expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(14);
      expect(parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth)).toBeGreaterThanOrEqual(12);
      expect(parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)).toBeGreaterThanOrEqual(
        16
      );

      const hostRect = m.host.getBoundingClientRect();
      const rect = bubble.getBoundingClientRect();
      expect(Math.abs(rect.right - hostRect.right)).toBeLessThan(1);
      // A short message makes a short bubble.
      expect(rect.width).toBeLessThan(200);
    } finally {
      m.dispose();
    }
  });

  it('grows to ~78% of the column and wraps; nothing escapes it in a narrow pane', async () => {
    for (const width of [720, 320]) {
      const m = await mountUser(user(`long-${width}`, LONG_PARAGRAPH), width);
      try {
        const bubble = m.row.querySelector<HTMLElement>('[data-user-bubble]')!;
        const rect = bubble.getBoundingClientRect();
        const maxW = width < 320 ? width : Math.floor(width * USER_BUBBLE_MAX_RATIO);
        expect(rect.width).toBeLessThanOrEqual(maxW);
        expect(rect.width).toBeGreaterThan(maxW - 40);
        expect(rect.height).toBeGreaterThan(60);
      } finally {
        m.dispose();
      }
    }
  });

  it('keeps long unbroken strings and code inside the bubble', async () => {
    for (const c of CASES.filter((x) => x.item.id === 'unbroken' || x.item.id === 'code')) {
      const m = await mountUser(c.item, c.width);
      try {
        const bubble = m.row.querySelector<HTMLElement>('[data-user-bubble]')!;
        const rect = bubble.getBoundingClientRect();
        expect(rect.right).toBeLessThanOrEqual(m.host.getBoundingClientRect().right + 0.5);
        // Text lines are laid out to fit: the bubble never has hidden horizontal overflow.
        expect(bubble.scrollWidth - bubble.clientWidth).toBeLessThanOrEqual(1);
      } finally {
        m.dispose();
      }
    }
  });

  it('shows attachments right-aligned above the bubble', async () => {
    const m = await mountUser(
      user('att', 'şu ekranlara bak', { attachments: [...images(2), files[0]!] }),
      720
    );
    try {
      const bubble = m.row.querySelector<HTMLElement>('[data-user-bubble]')!;
      const thumbs = m.row.querySelectorAll('img');
      expect(thumbs.length).toBe(2);
      const bubbleRect = bubble.getBoundingClientRect();
      for (const t of thumbs) {
        expect(bubble.contains(t)).toBe(false);
        expect(t.getBoundingClientRect().bottom).toBeLessThanOrEqual(bubbleRect.top + 0.5);
      }
      const lastThumb = thumbs[thumbs.length - 1]!.getBoundingClientRect();
      expect(Math.abs(lastThumb.right - m.host.getBoundingClientRect().right)).toBeLessThan(2);
    } finally {
      m.dispose();
    }
  });

  it('renders no bubble for an attachment-only message', async () => {
    const m = await mountUser(user('only', '', { attachments: images(1) }), 720);
    try {
      expect(m.row.querySelector('[data-user-bubble]')).toBeNull();
      expect(m.row.querySelectorAll('img').length).toBe(1);
    } finally {
      m.dispose();
    }
  });
});

describe('user message meta row', () => {
  it('shows a Turkish relative time, hidden until hover, with its height always reserved', async () => {
    const item = user('time', 'merhaba', { createdAt: Date.now() - 15 * 60_000 - 5_000 });
    const m = await mountUser(item, 720);
    try {
      const time = m.row.querySelector('time')!;
      expect(time.textContent).toBe('15 dakika önce');
      expect(time.getAttribute('title')).toBeTruthy();
      const bar = time.parentElement!;
      expect(getComputedStyle(bar).opacity).toBe('0');
      expect(bar.getBoundingClientRect().height).toBe(messageUnitDef.vars!.userFooterH);
      expect(getComputedStyle(bar).animationName).toBe('none');
    } finally {
      m.dispose();
    }
  });

  it('renders only the actions the host wired, and they call the real handlers', async () => {
    const calls: string[] = [];
    const item = user('acts', 'düzenle beni', { promptId: 'p-1', createdAt: Date.now() });

    const bare = await mountUser(item, 720);
    try {
      // No host commands: only copy (handled locally) is offered.
      const labels = Array.from(bare.row.querySelectorAll('button')).map((b) =>
        b.getAttribute('aria-label')
      );
      expect(labels).toEqual(['Kopyala']);
    } finally {
      bare.dispose();
    }

    const wired = await mountUser(item, 720, {
      onRewind: ({ promptId }) => calls.push(`rewind:${promptId}`),
      onEditMessage: ({ text }) => calls.push(`edit:${text}`),
    });
    try {
      const buttons = Array.from(wired.row.querySelectorAll<HTMLButtonElement>('button'));
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
        'Bu mesaja geri sar',
        'Yeniden yaz',
        'Kopyala',
      ]);
      for (const b of buttons) {
        expect(b.getAttribute('data-tooltip')).toBeTruthy();
        // Every action lives in the meta row under the bubble, none inside it.
        expect(b.closest('[data-user-bubble]')).toBeNull();
      }
      buttons[0]!.click();
      buttons[1]!.click();
      expect(calls).toEqual(['rewind:p-1', 'edit:düzenle beni']);
    } finally {
      wired.dispose();
    }
  });

  it('offers Stop for the generating message only when the host wired onStop', async () => {
    const item = user('gen', 'çalış', { createdAt: Date.now() });
    const generating: TurnState = { currentMessageId: () => 'gen', turnStatus: () => 'generating' };
    const labels = (row: HTMLElement) =>
      Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));

    // Previously a Stop button was drawn inside the bubble even without a handler (a dead button).
    const unwired = await mountUser(item, 720, {}, generating);
    try {
      expect(labels(unwired.row)).not.toContain('Durdur');
    } finally {
      unwired.dispose();
    }

    const stopped: string[] = [];
    const wired = await mountUser(
      item,
      720,
      { onStop: ({ itemId }) => stopped.push(itemId) },
      generating
    );
    try {
      const stop = Array.from(wired.row.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.getAttribute('aria-label') === 'Durdur'
      )!;
      expect(stop).toBeDefined();
      expect(stop.closest('[data-user-bubble]')).toBeNull();
      stop.click();
      expect(stopped).toEqual(['gen']);
    } finally {
      wired.dispose();
    }
  });
});
