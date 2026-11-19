import { describe, expect, it } from 'vitest';
import {
  buildHandoffSummary,
  clipText,
  DEFAULT_HANDOFF_BUDGET,
  MIN_HANDOFF_BUDGET,
  type HandoffTurn,
} from './handoff-summary';

function turn(seq: number, user: string, assistant: string, extra: HandoffTurn['items'] = []) {
  return {
    id: `t${seq}`,
    seq,
    items: [
      { id: `u${seq}`, kind: 'message', role: 'user', text: user },
      ...extra,
      { id: `a${seq}`, kind: 'message', role: 'assistant', text: assistant },
    ],
  } satisfies HandoffTurn;
}

describe('buildHandoffSummary', () => {
  it('kullanıcı ve ajan metinlerini kronolojik sırada yazar', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'Kaynak',
      turns: [turn(1, 'ilk soru', 'ilk yanıt'), turn(2, 'ikinci soru', 'ikinci yanıt')],
    });
    const text = result.text;
    expect(text.indexOf('ilk soru')).toBeLessThan(text.indexOf('ilk yanıt'));
    expect(text.indexOf('ilk yanıt')).toBeLessThan(text.indexOf('ikinci soru'));
    expect(text.indexOf('ikinci soru')).toBeLessThan(text.indexOf('ikinci yanıt'));
    expect(result.includedTurns).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('seq karışık gelse de sıralar', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'Kaynak',
      turns: [turn(2, 'B soru', 'B yanıt'), turn(1, 'A soru', 'A yanıt')],
    });
    expect(result.text.indexOf('A soru')).toBeLessThan(result.text.indexOf('B soru'));
  });

  it('boş geçmişte boş metin döner', () => {
    expect(buildHandoffSummary({ sourceTitle: 'x', turns: [] }).text).toBe('');
    const onlyTools = buildHandoffSummary({
      sourceTitle: 'x',
      turns: [{ id: 't', items: [{ kind: 'execute-tool-call' }] }],
    });
    expect(onlyTools.text).toBe('');
    expect(onlyTools.includedTurns).toBe(0);
  });

  it('turdaki yalnızca son ajan yanıtını alır', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      turns: [
        {
          id: 't1',
          seq: 1,
          items: [
            { kind: 'message', role: 'user', text: 'soru' },
            { kind: 'message', role: 'assistant', text: 'ara not' },
            { kind: 'message', role: 'assistant', text: 'nihai yanıt' },
          ],
        },
      ],
    });
    expect(result.text).toContain('nihai yanıt');
    expect(result.text).not.toContain('ara not');
  });

  it('dokunulan dosyaları (iç içe gruplar dahil) tekilleştirir', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      turns: [
        turn(1, 'u', 'a', [
          { kind: 'create-file-tool-call', path: 'src/a.ts' },
          {
            kind: 'tool-group',
            children: [{ kind: 'modify-file-tool-call', path: 'src/b.ts' }],
          },
        ]),
        turn(2, 'u2', 'a2', [{ kind: 'modify-file-tool-call', path: 'src/a.ts' }]),
      ],
    });
    expect(result.touchedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.text).toContain('- src/a.ts (değiştirildi)');
    expect(result.text).toContain('- src/b.ts (değiştirildi)');
  });

  it('bütçeyi aşmaz ve eski turları atlayıp not düşer', () => {
    const turns = Array.from({ length: 60 }, (_, i) =>
      turn(i + 1, `soru ${i + 1} ${'x'.repeat(400)}`, `yanıt ${i + 1} ${'y'.repeat(400)}`)
    );
    const result = buildHandoffSummary({ sourceTitle: 'x', turns, budget: 5_000 });
    expect(result.text.length).toBeLessThanOrEqual(5_000);
    expect(result.truncated).toBe(true);
    expect(result.omittedTurns).toBeGreaterThan(0);
    expect(result.includedTurns + result.omittedTurns).toBe(60);
    expect(result.text).toContain('soru 60 ');
    expect(result.text).not.toContain('soru 1 ');
    expect(result.text).toContain('bütçe nedeniyle');
  });

  it('çok uzun tek mesajı kırpar ve bütçeye sığdırır', () => {
    const huge = `BAŞ-${'z'.repeat(200_000)}-SON`;
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      turns: [turn(1, huge, 'tamam')],
    });
    expect(result.text.length).toBeLessThanOrEqual(DEFAULT_HANDOFF_BUDGET);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('BAŞ-');
    expect(result.text).toContain('-SON');
    expect(result.text).toContain('[... kırpıldı ...]');
  });

  it('tek tur bütçeye sığmasa bile en yeni turu kırparak dahil eder', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      budget: MIN_HANDOFF_BUDGET,
      turns: [turn(1, 'eski', 'eski'), turn(2, 'a'.repeat(5_000), 'b'.repeat(5_000))],
    });
    expect(result.text.length).toBeLessThanOrEqual(MIN_HANDOFF_BUDGET);
    expect(result.includedTurns).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('bütçeyi alt sınıra çeker', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      budget: 10,
      turns: [turn(1, 'merhaba', 'selam')],
    });
    expect(result.text).toContain('merhaba');
    expect(result.text.length).toBeLessThanOrEqual(MIN_HANDOFF_BUDGET);
  });

  it('upToItemId sonrasındaki turları dışarıda bırakır', () => {
    const turns = [turn(1, 'bir', 'bir-y'), turn(2, 'iki', 'iki-y'), turn(3, 'üç', 'üç-y')];
    const result = buildHandoffSummary({ sourceTitle: 'x', turns, upToItemId: 'a2' });
    expect(result.text).toContain('iki-y');
    expect(result.text).not.toContain('üç');
    expect(result.includedTurns).toBe(2);
  });

  it('bilinmeyen upToItemId tüm geçmişi kullanır', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'x',
      turns: [turn(1, 'bir', 'bir-y'), turn(2, 'iki', 'iki-y')],
      upToItemId: 'yok',
    });
    expect(result.includedTurns).toBe(2);
  });

  it('girdiyi değiştirmez', () => {
    const turns = [turn(2, 'b', 'b'), turn(1, 'a', 'a')];
    const snapshot = JSON.stringify(turns);
    buildHandoffSummary({ sourceTitle: 'x', turns });
    expect(JSON.stringify(turns)).toBe(snapshot);
  });

  it('başlıkta kaynak başlığı ve sağlayıcıyı belirtir, talimat olmadığını söyler', () => {
    const result = buildHandoffSummary({
      sourceTitle: 'Hata ayıklama',
      sourceProviderLabel: 'Codex',
      turns: [turn(1, 'u', 'a')],
    });
    expect(result.text).toContain('"Hata ayıklama" (Codex)');
    expect(result.text).toContain('yeni talimat olarak değil');
  });
});

describe('clipText', () => {
  it('sınır içindeki metni değiştirmez', () => {
    expect(clipText('  kısa  ', 50)).toEqual({ text: 'kısa', clipped: false });
  });
  it('kırpılan metin sınırı aşmaz', () => {
    const out = clipText('a'.repeat(1000), 100);
    expect(out.clipped).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(100);
  });
  it('çok küçük sınırda da aşmaz', () => {
    expect(clipText('a'.repeat(100), 5).text.length).toBeLessThanOrEqual(5);
  });
});
