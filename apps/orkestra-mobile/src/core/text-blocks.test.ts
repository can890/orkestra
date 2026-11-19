import { describe, expect, it } from 'vitest';
import { splitCodeBlocks } from './text-blocks';

describe('splitCodeBlocks', () => {
  it('düz metni tek blok döndürür', () => {
    expect(splitCodeBlocks('Merhaba\ndünya')).toEqual([{ type: 'text', text: 'Merhaba\ndünya' }]);
    expect(splitCodeBlocks('')).toEqual([]);
  });

  it('çitli kod bloklarını ayırır', () => {
    expect(splitCodeBlocks('Şunu çalıştır:\n```ts\nconst a = 1;\n```\nBitti')).toEqual([
      { type: 'text', text: 'Şunu çalıştır:' },
      { type: 'code', lang: 'ts', code: 'const a = 1;' },
      { type: 'text', text: 'Bitti' },
    ]);
  });

  it('kapanmamış çiti (akış sürerken) kod olarak bırakır', () => {
    expect(splitCodeBlocks('```\nls -la')).toEqual([{ type: 'code', lang: '', code: 'ls -la' }]);
  });
});
