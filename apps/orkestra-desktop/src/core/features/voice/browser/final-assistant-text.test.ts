import { describe, expect, it } from 'vitest';
import { finalAssistantText, latestSpeakableTurn } from './final-assistant-text';

describe('finalAssistantText', () => {
  it('tamamlanan turdaki son boş olmayan asistan mesajını seçer', () => {
    expect(
      finalAssistantText({
        id: 't',
        outcome: { kind: 'done' },
        items: [
          { kind: 'message', role: 'user', text: 'soru' },
          { kind: 'message', role: 'assistant', text: 'ara not' },
          { kind: 'tool' },
          { kind: 'message', role: 'assistant', text: 'Sonuç hazır.' },
          { kind: 'message', role: 'assistant', text: '  ' },
        ],
      })
    ).toBe('Sonuç hazır.');
  });

  it('iptal edilen ya da hatalı turu okumaz', () => {
    const items = [{ kind: 'message', role: 'assistant', text: 'yarım' }];
    expect(finalAssistantText({ id: 't', outcome: { kind: 'cancelled' }, items })).toBeNull();
    expect(finalAssistantText({ id: 't', outcome: { kind: 'error' }, items })).toBeNull();
    expect(finalAssistantText({ id: 't', items })).toBe('yarım');
    expect(finalAssistantText(null)).toBeNull();
  });

  it('etkin tur varsa onu, yoksa son görüntülenen turu seçer', () => {
    const a = { id: 'a', items: [] };
    const b = { id: 'b', items: [] };
    expect(latestSpeakableTurn([a], b)).toBe(b);
    expect(latestSpeakableTurn([a, b], null)).toBe(b);
    expect(latestSpeakableTurn([], null)).toBeNull();
  });
});
