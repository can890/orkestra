/**
 * Browser contract tests for createChatView / ChatView.setModel.
 *
 * These run in Chromium via @vitest/browser-playwright so they have real DOM
 * layout and Solid's reactive scheduler. They guard against regressions in the
 * Monaco-style model-swap introduced in the ChatView setModel refactor.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { generateMockTranscript } from '@/mock-transcript';
import type { ChatPlanEntry, TranscriptTurn } from '@/model';
import { createChatState, pinTopMode } from '@/state/chat-state';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve after two rAF ticks so Solid has committed a reactive update. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitFor<T>(fn: () => T | null, frames = 10): Promise<T | null> {
  for (let i = 0; i < frames; i++) {
    const value = fn();
    if (value) return value;
    await nextPaint();
  }
  return null;
}

async function mountPlan(entries: ChatPlanEntry[]) {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const plan = { kind: 'plan' as const, id: 'plan-fade-contract', entries };
  state.transcript.history.seed([
    {
      id: 'plan-turn',
      seq: 0,
      initiator: 'agent',
      // ChatPlan is a renderer-owned compatibility item accepted by the transcript flattener.
      items: [plan] as unknown as TranscriptTurn['items'],
    },
  ]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });
  await nextPaint();

  return {
    host,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createChatView', () => {
  it('mounts without error', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(10, 1));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    let view: ReturnType<typeof createChatView> | null = null;
    expect(() => {
      view = createChatView({ context: ctx, state, parent: host });
    }).not.toThrow();

    await nextPaint();
    view!.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('scrolls to top and bottom through the view handle', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(80, 10));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:300px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    const scrollEl = host.querySelector('[data-chat-scroll]') as HTMLElement | null;
    expect(scrollEl).not.toBeNull();

    view.scrollToBottom();
    await nextPaint();
    expect(scrollEl!.scrollTop).toBeGreaterThan(0);

    view.scrollToTop();
    await nextPaint();
    expect(scrollEl!.scrollTop).toBe(0);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('aligns the pinned prompt pill with the measured transcript column', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(80, 11));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });
    await nextPaint();

    view.scrollToBottom();
    // The pinned copy is a one-line pill, not a second user card.
    const pinnedRow = await waitFor(
      () => host.querySelector('[data-pinned-user-message]') as HTMLElement | null
    );

    expect(pinnedRow).not.toBeNull();
    expect(pinnedRow!.querySelector('[data-user-card]')).toBeNull();

    const probe = host.querySelector('[data-chat-width-probe]') as HTMLElement | null;
    expect(probe).not.toBeNull();

    const rowRect = pinnedRow!.getBoundingClientRect();
    const probeRect = probe!.getBoundingClientRect();
    expect(Math.abs(rowRect.left - probeRect.left)).toBeLessThan(1);
    expect(Math.abs(rowRect.width - probeRect.width)).toBeLessThan(1);
    // The pill hugs the right edge of the column, where inline prompts sit, on a single line.
    const pill = pinnedRow!.querySelector('button') as HTMLElement;
    const pillRect = pill.getBoundingClientRect();
    expect(pillRect.right).toBeLessThanOrEqual(rowRect.right + 0.5);
    expect(pillRect.left).toBeGreaterThanOrEqual(rowRect.left - 0.5);
    expect(pillRect.height).toBeLessThanOrEqual(40);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('shows no pinned prompt when the header is turned off', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed(generateMockTranscript(80, 11));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
    document.body.appendChild(host);

    const view = createChatView({
      context: ctx,
      state,
      parent: host,
      pinUserMessages: true,
      pinnedUserMessageHeader: false,
    });
    await nextPaint();

    view.scrollToBottom();
    await nextPaint();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.querySelector('[data-pinned-user-message]')).toBeNull();

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });

  it('shows a long user prompt in full: no collapse, no click-to-expand', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const longText = Array.from(
      { length: 40 },
      (_, i) => `Satır ${i + 1}: uzun bir istek metni.`
    ).join('\n\n');
    const turn: TranscriptTurn = {
      id: 'long-turn',
      seq: 1,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'long-user', seq: 0, role: 'user', text: longText },
        { kind: 'message', id: 'long-reply', seq: 1, role: 'assistant', text: 'Tamam.' },
      ],
    };
    state.transcript.history.seed([turn]);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });

    try {
      await nextPaint();
      const card = await waitFor(() =>
        host.querySelector<HTMLElement>('[data-chat-canvas] [data-user-card="long-user"]')
      );
      expect(card).not.toBeNull();
      await nextPaint();
      const fullHeight = card!.getBoundingClientRect().height;
      // 40 paragraphs are far taller than the old 120 px collapsed / 360 px expanded caps.
      expect(fullHeight).toBeGreaterThan(600);
      expect(card!.scrollHeight - card!.clientHeight).toBeLessThanOrEqual(1);
      expect(getComputedStyle(card!).cursor).not.toBe('pointer');

      card!.click();
      await nextPaint();
      await nextPaint();
      expect(Math.abs(card!.getBoundingClientRect().height - fullHeight)).toBeLessThan(1);

      // The reply sits right below the full prompt, never overlapping it.
      const reply = Array.from(host.querySelectorAll('*')).find(
        (element) => element.children.length === 0 && element.textContent === 'Tamam.'
      )!;
      expect(reply.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        card!.getBoundingClientRect().bottom
      );
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      host.remove();
    }
  });

  it('shows a host-sent user message as a compact notice with its full text on demand', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const requestText = [
      '[Bağlam devri] Bu sohbetin bağlamı dolmak üzere.',
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Başlık ${i + 1}`),
    ].join('\n\n');
    const turn: TranscriptTurn = {
      id: 'notice-turn',
      seq: 1,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'brief-request', seq: 0, role: 'user', text: requestText },
        { kind: 'message', id: 'brief-reply', seq: 1, role: 'assistant', text: 'Devir notu.' },
      ],
    };
    const ordinary: TranscriptTurn = {
      id: 'ordinary-turn',
      seq: 2,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'plain-user', seq: 0, role: 'user', text: 'Teşekkürler, devam.' },
      ],
    };
    state.transcript.history.seed([turn, ordinary]);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:900px;';
    document.body.appendChild(host);
    const view = createChatView({
      context: ctx,
      state,
      parent: host,
      commands: {
        systemNotice: (message) =>
          message.text.startsWith('[Bağlam devri]')
            ? { label: 'Bağlam devri: ajandan devir notu istendi' }
            : null,
      },
    });

    const replyBox = () =>
      Array.from(host.querySelectorAll('*'))
        .find((element) => element.children.length === 0 && element.textContent === 'Devir notu.')!
        .getBoundingClientRect();

    try {
      await nextPaint();
      const notice = await waitFor(() =>
        host.querySelector<HTMLElement>('[data-chat-canvas] [data-system-notice="brief-request"]')
      );
      expect(notice).not.toBeNull();
      // Not a user card; ordinary prompts still are.
      expect(host.querySelector('[data-user-card="brief-request"]')).toBeNull();
      expect(host.querySelector('[data-user-card="plain-user"]')).not.toBeNull();
      expect(notice!.textContent).toContain('Bağlam devri: ajandan devir notu istendi');
      expect(notice!.textContent).not.toContain('Başlık 12');
      const collapsed = notice!.getBoundingClientRect();
      expect(collapsed.height).toBeLessThan(40);
      expect(replyBox().top).toBeGreaterThanOrEqual(collapsed.bottom);

      notice!.querySelector<HTMLElement>('[data-collapse-id="brief-request"]')!.click();
      // Let the expand tween settle.
      for (let i = 0; i < 30; i += 1) await nextPaint();
      const expanded = notice!.getBoundingClientRect();
      expect(notice!.textContent).toContain('Başlık 12');
      expect(expanded.height).toBeGreaterThan(collapsed.height + 200);
      // Reserved height matches what is drawn: the reply still starts below the open notice.
      expect(replyBox().top).toBeGreaterThanOrEqual(expanded.bottom - 1);

      notice!.querySelector<HTMLElement>('[data-collapse-id="brief-request"]')!.click();
      for (let i = 0; i < 30; i += 1) await nextPaint();
      expect(Math.abs(notice!.getBoundingClientRect().height - collapsed.height)).toBeLessThan(1);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      host.remove();
    }
  });

  it('keeps the notice glyph and label on one measured line under a host svg reset', async () => {
    // The desktop app loads Tailwind preflight, which makes every svg a block box. That used to
    // push the glyph onto its own line above the label (two drawn lines in a one-line slot).
    const preflight = document.createElement('style');
    preflight.textContent = 'svg { display: block; vertical-align: middle; }';
    document.head.appendChild(preflight);

    const label = 'Bağlam devri: ajandan devir notu istendi, uzun bir etiket ile dar bölmede';
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed([
      {
        id: 'notice-turn',
        seq: 1,
        initiator: 'user',
        items: [
          {
            kind: 'message',
            id: 'brief-request',
            seq: 0,
            role: 'user',
            text: `[Bağlam devri] ${'Bu sohbetin bağlamı dolmak üzere; iş yeni sohbete taşınıyor. '.repeat(6)}`,
          },
          { kind: 'message', id: 'brief-reply', seq: 1, role: 'assistant', text: 'Devir notu.' },
        ],
      },
    ]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({
      context: ctx,
      state,
      parent: host,
      commands: {
        systemNotice: (message) => (message.text.startsWith('[Bağlam devri]') ? { label } : null),
      },
    });

    const lineHeight = DEFAULT_THEME.fonts.body.lineHeight;
    const check = async (width: number) => {
      host.style.width = `${width}px`;
      for (let i = 0; i < 6; i += 1) await nextPaint();
      const notice = (await waitFor(() =>
        host.querySelector<HTMLElement>('[data-chat-canvas] [data-system-notice="brief-request"]')
      ))!;
      const header = notice.querySelector<HTMLElement>('[data-collapse-id="brief-request"]')!;
      const glyph = header.querySelector('svg')!.getBoundingClientRect();
      const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
      let labelNode: Node | null = null;
      while (walker.nextNode()) {
        if (walker.currentNode.textContent === label) labelNode = walker.currentNode;
      }
      expect(labelNode).not.toBeNull();
      const range = document.createRange();
      range.selectNodeContents(labelNode!);
      const labelBox = range.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const noticeBox = notice.getBoundingClientRect();

      // Glyph sits to the left of the label, on the same line.
      expect(glyph.right).toBeLessThanOrEqual(labelBox.left + 1);
      const glyphMid = (glyph.top + glyph.bottom) / 2;
      const labelMid = (labelBox.top + labelBox.bottom) / 2;
      expect(Math.abs(glyphMid - labelMid)).toBeLessThan(3);
      // One drawn line, inside the reserved header slot; the row is exactly the measured header.
      // (Chromium reports an ellipsised text node as several fragments, all on the same line.)
      const lineTops = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
      expect(lineTops.size).toBe(1);
      expect(labelBox.height).toBeLessThanOrEqual(lineHeight + 1);
      expect(glyph.top).toBeGreaterThanOrEqual(headerBox.top - 0.5);
      expect(labelBox.bottom).toBeLessThanOrEqual(headerBox.bottom + 0.5);
      expect(header.scrollHeight).toBeLessThanOrEqual(header.clientHeight);
      expect(Math.abs(noticeBox.height - headerBox.height)).toBeLessThan(0.5);
      // Nothing spills past the transcript column horizontally.
      expect(headerBox.right).toBeLessThanOrEqual(host.getBoundingClientRect().right + 0.5);
      return { notice: noticeBox.height, label: labelNode!.parentElement! };
    };

    try {
      const wide = await check(800);
      expect(wide.label.scrollWidth).toBeLessThanOrEqual(wide.label.clientWidth);
      const narrow = await check(320);
      // In a narrow split pane the label is cut with an ellipsis, it does not wrap.
      expect(narrow.label.scrollWidth).toBeGreaterThan(narrow.label.clientWidth);
      expect(narrow.notice).toBeCloseTo(wide.notice, 1);

      // Opened in the narrow pane, the full text wraps inside the panel the measurement reserved.
      const notice = host.querySelector<HTMLElement>('[data-system-notice="brief-request"]')!;
      notice.querySelector<HTMLElement>('[data-collapse-id="brief-request"]')!.click();
      for (let i = 0; i < 30; i += 1) await nextPaint();
      const panel = notice.lastElementChild as HTMLElement;
      expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight + 1);
      expect(
        Math.abs(notice.getBoundingClientRect().height - parseFloat(notice.style.height))
      ).toBeLessThan(1);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      host.remove();
      preflight.remove();
    }
  });

  it('pins a prompt below a top inset when the host floats controls over the transcript', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const previous = generateMockTranscript(8, 12);
    const active: TranscriptTurn = {
      id: 'outgoing-turn',
      seq: 100,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'outgoing-user', seq: 0, role: 'user', text: 'Say hello' },
        { kind: 'message', id: 'outgoing-reply', seq: 1, role: 'assistant', text: 'Hello!' },
      ],
    };
    const position = {
      generation: 'pinned-inset',
      historyRevision: 0,
      lastCommittedTurnSeq: previous.at(-1)?.seq ?? null,
    };
    state.transcript.applyPage({
      turns: previous,
      nextCursor: null,
      position,
      coverage: { fromSeq: null, beforeSeq: null },
    });
    state.transcript.observe({ ...position, activeTurn: active });

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });

    try {
      await nextPaint();
      const cardTop = async () => {
        await nextPaint();
        await nextPaint();
        const card = host.querySelector<HTMLElement>(
          '[data-chat-canvas] [data-user-card="outgoing-user"]'
        );
        const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
        return card!.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      };
      view.setScrollMode(pinTopMode('outgoing-user'));
      const flush = await cardTop();
      view.setScrollMode(pinTopMode('outgoing-user', 36));
      const inset = await cardTop();
      expect(flush).toBeLessThan(30);
      expect(Math.abs(inset - flush - 36)).toBeLessThan(1);
    } finally {
      view.dispose();
      ctx.dispose();
      state.dispose();
      host.remove();
    }
  });

  it.each([0, 8])(
    'keeps a short outgoing turn pinned while history is delayed with %i previous turns',
    async (historySize) => {
      const ctx = createChatContext({ theme: DEFAULT_THEME });
      const state = createChatState(ctx);
      const previous = generateMockTranscript(historySize, 12);
      const active: TranscriptTurn = {
        id: 'outgoing-turn',
        seq: 100,
        initiator: 'user',
        items: [
          { kind: 'message', id: 'outgoing-user', seq: 0, role: 'user', text: 'Say hello' },
          { kind: 'message', id: 'outgoing-reply', seq: 1, role: 'assistant', text: 'Hello!' },
        ],
      };
      const position = {
        generation: 'pinned-handoff',
        historyRevision: 0,
        lastCommittedTurnSeq: previous.at(-1)?.seq ?? null,
      };
      state.transcript.applyPage({
        turns: previous,
        nextCursor: null,
        position,
        coverage: { fromSeq: null, beforeSeq: null },
      });
      state.transcript.observe({ ...position, activeTurn: active });

      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
      document.body.appendChild(host);
      const view = createChatView({ context: ctx, state, parent: host, pinUserMessages: true });

      try {
        await nextPaint();
        view.scrollToBottom();
        const userCard = await waitFor(() =>
          host.querySelector<HTMLElement>('[data-chat-canvas] [data-user-card="outgoing-user"]')
        );
        expect(userCard).not.toBeNull();
        await nextPaint();
        const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
        const pinnedTop = userCard!.getBoundingClientRect().top;
        const pinnedScroll = scroll.scrollTop;
        expect(pinnedTop - scroll.getBoundingClientRect().top).toBeLessThan(100);

        const committedPosition = { ...position, historyRevision: 1, lastCommittedTurnSeq: 100 };
        state.transcript.observe({ ...committedPosition, activeTurn: null });
        await nextPaint();
        await nextPaint();

        expect(state.transcript.state.committedTurns).toHaveLength(historySize);
        expect(Math.abs(scroll.scrollTop - pinnedScroll)).toBeLessThan(1);
        const retainedCard = host.querySelector<HTMLElement>(
          '[data-chat-canvas] [data-user-card="outgoing-user"]'
        );
        expect(retainedCard).not.toBeNull();
        expect(Math.abs(retainedCard!.getBoundingClientRect().top - pinnedTop)).toBeLessThan(1);

        state.transcript.applyPage({
          turns: [...previous, { ...active, outcome: { kind: 'done', reason: 'end_turn' } }],
          nextCursor: null,
          position: committedPosition,
          coverage: { fromSeq: null, beforeSeq: null },
        });
        await nextPaint();
        expect(Math.abs(scroll.scrollTop - pinnedScroll)).toBeLessThan(1);
      } finally {
        view.dispose();
        ctx.dispose();
        state.dispose();
        host.remove();
      }
    }
  );
});

describe('plan preview fade', () => {
  it('only shows the bottom fade when rendered entries overflow the preview', async () => {
    const fitting = await mountPlan([
      { content: 'Review the repository', status: 'completed', priority: 'high' },
      { content: 'Summarize the architecture', status: 'in_progress', priority: 'medium' },
      { content: 'Document requirements', status: 'pending', priority: 'medium' },
    ]);

    try {
      const scroll = fitting.host.querySelector('[data-preview-scroll]');
      expect(scroll).not.toBeNull();
      expect(scroll!.scrollHeight).toBeLessThanOrEqual(scroll!.clientHeight);
      expect(fitting.host.querySelector('[data-preview-overlay="fade-bottom"]')).toBeNull();
    } finally {
      fitting.dispose();
    }

    const overflowing = await mountPlan(
      Array.from({ length: 5 }, () => ({
        content: '',
        status: 'pending' as const,
        priority: 'medium' as const,
      }))
    );

    try {
      const scroll = overflowing.host.querySelector('[data-preview-scroll]');
      expect(scroll).not.toBeNull();
      expect(scroll!.scrollHeight).toBeGreaterThan(scroll!.clientHeight);
      expect(overflowing.host.querySelector('[data-preview-overlay="fade-bottom"]')).not.toBeNull();
    } finally {
      overflowing.dispose();
    }
  });
});

describe('ChatView.setModel', () => {
  it('swaps models without throwing', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    const stateB = createChatState(ctx, { uri: 'conv-b' });
    stateA.transcript.history.seed(generateMockTranscript(12, 2));
    stateB.transcript.history.seed(generateMockTranscript(12, 3));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    expect(() => view.setModel(stateB)).not.toThrow();
    await nextPaint();

    expect(() => view.setModel(stateA)).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    stateB.dispose();
    document.body.removeChild(host);
  });

  it('is a no-op when called with the current model', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    stateA.transcript.history.seed(generateMockTranscript(8, 4));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    // Calling setModel with the same state should not throw or crash.
    expect(() => view.setModel(stateA)).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    document.body.removeChild(host);
  });

  it('continues rendering streaming updates on the new model after swap', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const stateA = createChatState(ctx, { uri: 'conv-a' });
    const stateB = createChatState(ctx, { uri: 'conv-b' });
    stateA.transcript.history.seed(generateMockTranscript(6, 5));
    stateB.transcript.history.seed(generateMockTranscript(6, 6));

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: stateA, parent: host });
    await nextPaint();

    view.setModel(stateB);
    await nextPaint();

    // Stream into stateB after the swap — should not crash.
    expect(() => {
      stateB.transcript.activeTurn.set(
        {
          id: 'active-turn-b',
          seq: 99,
          initiator: 'agent',
          items: [
            {
              kind: 'message',
              id: 'msg-1',
              seq: 0,
              role: 'assistant',
              text: 'Hello from model B',
            },
          ],
        },
        'generating'
      );
    }).not.toThrow();
    await nextPaint();

    expect(() => {
      stateB.transcript.activeTurn.commit('done');
    }).not.toThrow();
    await nextPaint();

    view.dispose();
    ctx.dispose();
    stateA.dispose();
    stateB.dispose();
    document.body.removeChild(host);
  });

  it('survives rapid model thrashing without error', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const states = Array.from({ length: 3 }, (_, i) => {
      const s = createChatState(ctx, { uri: `conv-${i}` });
      s.transcript.history.seed(generateMockTranscript(10, i + 7));
      return s;
    });

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);

    const view = createChatView({ context: ctx, state: states[0], parent: host });
    await nextPaint();

    // Thrash through 30 switches.
    const errors: string[] = [];
    for (let i = 0; i < 30; i++) {
      try {
        view.setModel(states[i % states.length]);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    await nextPaint();

    expect(errors).toHaveLength(0);

    view.dispose();
    ctx.dispose();
    for (const s of states) s.dispose();
    document.body.removeChild(host);
  });
});
