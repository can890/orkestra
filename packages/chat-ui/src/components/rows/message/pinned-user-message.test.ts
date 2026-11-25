import { describe, expect, it } from 'vitest';
import { pinnedPromptLine } from './pinned-prompt-line';

describe('pinnedPromptLine', () => {
  it('uses the first non-empty line and collapses whitespace', () => {
    expect(pinnedPromptLine('\n\n  kanka   tüm iş bitince\nikinci satır')).toBe(
      'kanka tüm iş bitince'
    );
  });

  it('drops markdown markers so the pill reads as plain text', () => {
    expect(pinnedPromptLine('## **Sıradaki Adım:** `Huawei` → Drive')).toBe(
      'Sıradaki Adım: Huawei → Drive'
    );
    expect(pinnedPromptLine('> alıntı satırı')).toBe('alıntı satırı');
  });

  it('returns an empty string for a message without text', () => {
    expect(pinnedPromptLine('   \n  ')).toBe('');
  });
});
