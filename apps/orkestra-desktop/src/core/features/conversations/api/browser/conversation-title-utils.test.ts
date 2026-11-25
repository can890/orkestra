import { afterEach, describe, expect, it } from 'vitest';
import {
  rememberAgentDisplayNames,
  resetAgentDisplayNamesForTests,
} from '@core/features/agents/api/browser/agent-display-names';
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

  afterEach(() => resetAgentDisplayNamesForTests());

  it('shows the display name of a custom ACP agent instead of its id', () => {
    rememberAgentDisplayNames([
      { id: 'acp-local-h-zl-ajan', name: 'Hızlı Ajan' },
      { id: 'acp-local-yavas-ajan', name: 'Yavaş Ajan' },
    ]);
    expect(
      formatConversationTitleForDisplay('acp-local-h-zl-ajan', 'Acp-local-h-zl-ajan (1)')
    ).toBe('Hızlı Ajan (1)');
    // Devir başlığı ve başka bir sağlayıcıya geçilmiş sohbet de ajanın adını gösterir.
    expect(
      formatConversationTitleForDisplay('acp-local-yavas-ajan', 'Acp-local-yavas-ajan (1) (devam)')
    ).toBe('Yavaş Ajan (1) (devam)');
    expect(formatConversationTitleForDisplay('claude', 'Acp-local-yavas-ajan (2) (devir)')).toBe(
      'Yavaş Ajan (2) (devir)'
    );
  });

  it('falls back to the id while names are unknown and keeps built-in labels', () => {
    expect(formatConversationTitleForDisplay('acp-local-x', 'acp-local-x (1)')).toBe(
      'Acp-local-x (1)'
    );
    rememberAgentDisplayNames([{ id: 'claude', name: 'Claude Code' }]);
    expect(formatConversationTitleForDisplay('claude', 'claude (2)')).toBe('Claude (2)');
    expect(formatConversationTitleForDisplay('claude', 'Acp-local-x (1) notları')).toBe(
      'Acp-local-x (1) notları'
    );
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
