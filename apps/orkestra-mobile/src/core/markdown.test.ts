import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('başlık, paragraf, kod bloğu ve listeyi doğru ayrıştırır', () => {
    const input = [
      '# Özet',
      '',
      'Bu **kalın** ve `kod` içeren bir paragraf.',
      '',
      '- İlk madde',
      '- İkinci madde',
      '',
      '```ts',
      'const x = 42;',
      '```',
    ].join('\n');

    const blocks = parseMarkdown(input);
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'code']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[3]).toEqual({ kind: 'code', language: 'ts', code: 'const x = 42;' });
  });

  it('tabloları ve alıntıları ayrıştırır', () => {
    const input = ['> Not satırı', '', '| Ad | Değer |', '| --- | --- |', '| A | 1 |'].join('\n');
    const blocks = parseMarkdown(input);
    expect(blocks.map((block) => block.kind)).toEqual(['blockquote', 'table']);
  });

  it('yalnızca güvenli http/https bağlantıları kabul eder', () => {
    const safe = parseInline('[Orkestra](https://orkestra.dev)');
    expect(safe).toEqual([{ kind: 'link', label: 'Orkestra', href: 'https://orkestra.dev/' }]);

    const unsafe = parseInline('[Tıkla](javascript:alert(1))');
    expect(unsafe).toEqual([{ kind: 'text', text: '[Tıkla](javascript:alert(1))' }]);
  });
});

describe('parseMarkdown — listeler', () => {
  it('sıralı listeyi numaralı ve başlangıç numarasıyla ayrıştırır', () => {
    const [block] = parseMarkdown('15. on beş\n16. on altı');
    expect(block).toMatchObject({ kind: 'list', ordered: true, start: 15 });
    expect(block?.kind === 'list' && block.items).toHaveLength(2);
  });

  it('23 maddelik listeyi tek liste olarak tutar', () => {
    const md = Array.from({ length: 23 }, (_, i) => `${i + 1}. madde ${i + 1}`).join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, start: 1 });
    expect(blocks[0]?.kind === 'list' && blocks[0].items).toHaveLength(23);
  });

  it('boş satırla ayrılmış maddeleri aynı listede tutar (numara sıfırlanmaz)', () => {
    const blocks = parseMarkdown('1. a\n\n2. b\n\n3. c');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === 'list' && blocks[0].items).toHaveLength(3);
  });

  it('iç içe sırasız alt listeyi maddenin çocuğu yapar, dış numaralandırma bozulmaz', () => {
    const blocks = parseMarkdown('1. bir\n   - alt a\n   - alt b\n2. iki\n   1. derin');
    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('liste bekleniyordu');
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.children[0]).toMatchObject({ kind: 'list', ordered: false });
    expect(list.items[1]?.children[0]).toMatchObject({ kind: 'list', ordered: true, start: 1 });
  });

  it('karışık: sırasız listeden sonra gelen sıralı liste ayrı blok olur', () => {
    const blocks = parseMarkdown('- a\n- b\n1. x\n2. y');
    expect(blocks.map((b) => (b.kind === 'list' ? b.ordered : b.kind))).toEqual([false, true]);
  });

  it('görev listesi maddelerini işaretli/işaretsiz ayrıştırır', () => {
    const [block] = parseMarkdown('- [ ] yapılacak\n- [x] bitti');
    if (block?.kind !== 'list') throw new Error('liste bekleniyordu');
    expect(block.items.map((item) => item.checked)).toEqual([false, true]);
  });
});
