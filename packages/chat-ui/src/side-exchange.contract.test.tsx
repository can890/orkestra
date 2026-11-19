/**
 * Browser contract test: a side exchange renders as marked rows and "Ajana ilet" forwards the
 * original question without changing the transcript.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitFor<T>(fn: () => T | null, frames = 20): Promise<T | null> {
  for (let i = 0; i < frames; i++) {
    const value = fn();
    if (value) return value;
    await nextPaint();
  }
  return null;
}

const turn: TranscriptTurn = {
  id: 't1',
  seq: 0,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'uzun işe başla' },
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: 'başladım' },
    {
      kind: 'message',
      id: 'side:one:user',
      seq: 2,
      role: 'user',
      text: 'son durum ne?',
      side: { question: 'son durum ne?', status: 'done' },
    },
    {
      kind: 'message',
      id: 'side:one:assistant',
      seq: 3,
      role: 'assistant',
      text: 'İki dosya düzenlendi.',
      side: { question: 'son durum ne?', status: 'done' },
    },
  ],
};

describe('side exchange rows', () => {
  it('marks both halves and forwards the question from the answer', async () => {
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    state.transcript.history.seed([turn]);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const onForwardSideQuestion = vi.fn();
    const view = createChatView({
      context: ctx,
      state,
      parent: host,
      commands: { onForwardSideQuestion },
    });

    const sideCards = await waitFor(() => {
      const found = host.querySelectorAll('[data-user-card][data-side="true"]');
      return found.length ? found : null;
    });
    expect(sideCards).toHaveLength(1);
    expect(host.querySelectorAll('[data-user-card]:not([data-side])')).toHaveLength(1);
    expect(host.textContent).toContain('Yan cevap');

    const forward = host.querySelector('button[aria-label="Ajana ilet"]') as HTMLButtonElement;
    expect(forward).not.toBeNull();
    forward.click();
    expect(onForwardSideQuestion).toHaveBeenCalledWith({
      itemId: 'side:one:assistant',
      question: 'son durum ne?',
    });
    // Only the side answer offers it; the main assistant row does not.
    expect(host.querySelectorAll('button[aria-label="Ajana ilet"]')).toHaveLength(1);

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });
});
