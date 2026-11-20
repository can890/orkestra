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
