import { describe, expect, it } from 'vitest';
import {
  formatConversationTitleForDisplay,
  visibleConversationTitle,
} from './conversation-title-utils';

describe('visibleConversationTitle', () => {
  it('keeps a normal title', () => {
    expect(visibleConversationTitle('Giriş hatasını düzelt')).toBe('Giriş hatasını düzelt');
  });

  it('drops a hidden block that was truncated mid-way', () => {
    expect(
      visibleConversationTitle(
        "Sadece 'hazır' yaz. <orkestra_context> Orkestra can display generated files "
      )
    ).toBe("Sadece 'hazır' yaz.");
  });

  it('drops a complete hidden block', () => {
    expect(
      visibleConversationTitle('Başlık <orkestra_context>\ngizli\n</orkestra_context> devamı')
    ).toBe('Başlık  devamı');
  });

  it('returns the original when nothing visible would be left', () => {
    expect(visibleConversationTitle('<orkestra_context> yalnızca gizli')).toBe(
      '<orkestra_context> yalnızca gizli'
    );
  });
});

describe('formatConversationTitleForDisplay', () => {
  it('still formats default titles', () => {
    expect(formatConversationTitleForDisplay('kimi', 'kimi (2)')).toBe('Kimi (2)');
  });

  it('hides leaked hidden context in stored titles', () => {
    expect(
      formatConversationTitleForDisplay('kimi', 'Kısa mesaj <orkestra_context> Orkestra can')
    ).toBe('Kısa mesaj');
  });
});
