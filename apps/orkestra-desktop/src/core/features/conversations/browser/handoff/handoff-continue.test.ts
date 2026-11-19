import { describe, expect, it } from 'vitest';
import {
  composeHandoffHiddenContext,
  CONTINUE_PROMPT,
  createContinueHandler,
} from './handoff-continue';
import { HandoffStore } from './handoff-store';

const SUMMARY = '[Devir özeti] ... önceki konuşmanın kaydı ...';

describe('composeHandoffHiddenContext', () => {
  it('puts the handoff summary before any existing hidden context', () => {
    expect(composeHandoffHiddenContext(SUMMARY, 'issue bağlamı')).toBe(
      `${SUMMARY}\n\nissue bağlamı`
    );
  });

  it('passes the existing context through when there is no summary', () => {
    expect(composeHandoffHiddenContext(undefined, 'issue bağlamı')).toBe('issue bağlamı');
    expect(composeHandoffHiddenContext(undefined, undefined)).toBeUndefined();
  });
});

describe('createContinueHandler', () => {
  function setup() {
    const store = new HandoffStore(null);
    store.put('c2', {
      version: 1,
      mode: 'handoff',
      sourceConversationId: 'c1',
      sourceTitle: 'Eski sohbet',
      context: SUMMARY,
      createdAt: 1,
    });
    const sent: Array<{ text: string; hidden: string | undefined }> = [];
    const handler = createContinueHandler((text) => {
      sent.push({ text, hidden: composeHandoffHiddenContext(store.get('c2')?.context, undefined) });
    });
    return { sent, handler, store };
  }

  it('sends nothing until the user clicks', () => {
    const { sent } = setup();
    expect(sent).toEqual([]);
  });

  it('sends the standard message once per click, with the summary as hidden context only', () => {
    const { sent, handler, store } = setup();
    handler();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(CONTINUE_PROMPT);
    expect(sent[0]?.text).not.toContain('Devir özeti');
    expect(sent[0]?.hidden).toBe(SUMMARY);
    // Özet kayıtta durur: gönderim reddedilirse yeniden denemede yine eklenir.
    expect(store.get('c2')?.context).toBe(SUMMARY);
  });
});
