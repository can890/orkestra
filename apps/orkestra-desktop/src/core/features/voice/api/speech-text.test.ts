import { describe, expect, it } from 'vitest';
import { markdownToSpeechText } from './speech-text';

const speak = (markdown: string, maxChars = 2000) => markdownToSpeechText(markdown, { maxChars });

describe('markdownToSpeechText', () => {
  it('çitli kod bloklarını atlar ve yerine kısa bir ifade okur', () => {
    const text = speak(
      'Şu değişikliği yaptım:\n\n```ts\nconst a = 1;\nconsole.log(a);\n```\n\nTestler geçti.'
    );
    expect(text).toBe('Şu değişikliği yaptım: (kod bloğu atlandı). Testler geçti.');
    expect(text).not.toContain('const');
  });

  it('kapanmamış ve boş kod bloklarını da atlar', () => {
    expect(speak('Önce\n```\n```\nSonra')).toBe('Önce. (kod bloğu atlandı). Sonra.');
    expect(speak('Başla\n```bash\nrm -rf x')).toBe('Başla. (kod bloğu atlandı).');
    expect(
      markdownToSpeechText('A\n```\nx\n```', { maxChars: 100, codeBlockPlaceholder: '' })
    ).toBe('A.');
  });

  it('başlık, liste, vurgu ve satır içi kodu düz metne çevirir', () => {
    const text = speak(
      '## Özet\n\n- **Kalın** madde\n- `npm test` çalıştı\n1. _italik_ adım\n\n> alıntı ~~eski~~'
    );
    expect(text).toBe('Özet. Kalın madde. npm test çalıştı. 1. italik adım. alıntı eski.');
  });

  it('bağlantıların yalnızca metnini okur, çıplak adresleri kısaltır', () => {
    expect(speak('[Belgeler](https://example.com/docs) ve https://example.com/x bak')).toBe(
      'Belgeler ve bağlantı bak.'
    );
    expect(speak('![ekran görüntüsü](a.png)')).toBe('ekran görüntüsü.');
  });

  it('tabloları, yatay çizgileri ve HTML etiketlerini okumaz', () => {
    const text = speak(
      'Sonuç:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n<details>gizli</details>'
    );
    expect(text).toBe('Sonuç: gizli.');
  });

  it('snake_case gibi kelime içi alt çizgileri korur', () => {
    expect(speak('my_var_name değişti')).toBe('my_var_name değişti.');
  });

  it('uzun metni cümle sınırında keser ve sınırı aşmaz', () => {
    const text = speak('Bu bir test cümlesidir. '.repeat(50), 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('… Yanıtın devamı ekranda.')).toBe(true);
    expect(text.startsWith('Bu bir test cümlesidir.')).toBe(true);
  });

  it('yalnızca kod içeren yanıtta kısa bir ifade, boş girdide boş döner', () => {
    expect(speak('```\nx\n```')).toBe('(kod bloğu atlandı).');
    expect(speak('   \n\n ')).toBe('');
  });
});
