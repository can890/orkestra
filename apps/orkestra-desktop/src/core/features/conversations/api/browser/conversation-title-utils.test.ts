import { describe, expect, it } from 'vitest';
import {
  conversationTitleForDisplayInTask,
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

describe('conversationTitleForDisplayInTask', () => {
  const base = {
    providerId: 'claude',
    title: 'Claude (1)',
    taskName: 'Kedi görseli üret',
    taskConversationCount: 1,
  };

  it("shows the task's meaningful name for its single provider-default conversation", () => {
    expect(conversationTitleForDisplayInTask(base)).toBe('Kedi görseli üret');
    expect(conversationTitleForDisplayInTask({ ...base, title: 'claude (3)' })).toBe(
      'Kedi görseli üret'
    );
  });

  it('keeps the conversation title when the task has several conversations', () => {
    expect(conversationTitleForDisplayInTask({ ...base, taskConversationCount: 2 })).toBe(
      'Claude (1)'
    );
    expect(conversationTitleForDisplayInTask({ ...base, taskConversationCount: 0 })).toBe(
      'Claude (1)'
    );
  });

  it('keeps a user-given or provider-derived conversation title', () => {
    expect(conversationTitleForDisplayInTask({ ...base, title: 'Login hatası' })).toBe(
      'Login hatası'
    );
  });

  it('keeps the default title while the task name is still a placeholder', () => {
    for (const taskName of [
      'Yeni sohbet',
      'yeni görev',
      'New chat',
      'Claude (1)',
      'brave-fox-runs',
      'brave-fox-runs-2',
      '',
      '   ',
      null,
      undefined,
    ]) {
      expect(conversationTitleForDisplayInTask({ ...base, taskName }), String(taskName)).toBe(
        'Claude (1)'
      );
    }
  });
});
