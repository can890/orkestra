import { describe, expect, it } from 'vitest';
import {
  extractPromptSuggestionContext,
  type SuggestionTurn,
} from './prompt-suggestions-context';

describe('extractPromptSuggestionContext', () => {
  it('uzun asistan yanıtında başlangıç bağlamını ve sondaki seçenek/soru bölümünü korur', () => {
    const longMiddle = 'a'.repeat(3500);
    const tailQuestion = '\n1. Seçenek Bir\n2. Seçenek İki\nHangisini tercih edersin?';
    const turns: SuggestionTurn[] = [
      {
        id: 't1',
        items: [
          { kind: 'message', role: 'user', text: 'Bunu araştır' },
          { kind: 'message', role: 'assistant', text: `BAŞLANGIÇ_ÖZET ${longMiddle}${tailQuestion}` },
        ],
        outcome: { kind: 'done' },
      },
    ];

    const ctx = extractPromptSuggestionContext(turns);
    expect(ctx).not.toBeNull();
    expect(ctx?.lastUserText).toBe('Bunu araştır');
    expect(ctx?.lastAssistantText.startsWith('BAŞLANGIÇ_ÖZET')).toBe(true);
    expect(ctx?.lastAssistantText.endsWith('Hangisini tercih edersin?')).toBe(true);
  });

  it('tool-group altındaki düzenleme, okuma, komut ve plan araçlarını doğru toplar', () => {
    const turns: SuggestionTurn[] = [
      {
        id: 't2',
        items: [
          { kind: 'message', role: 'user', text: 'Özelliği yaz ve test et' },
          {
            kind: 'tool-group',
            children: [
              { kind: 'read-tool-call', status: 'done' },
              {
                kind: 'modify-file-tool-call',
                path: 'src/core/voice.ts',
                status: 'done',
              },
              {
                kind: 'create-file-tool-call',
                path: 'src/core/voice.test.ts',
                status: 'done',
              },
              {
                kind: 'execute-tool-call',
                command: 'pnpm test',
                status: 'done',
              },
              {
                kind: 'execute-tool-call',
                command: 'pnpm tsgo',
                status: 'error',
              },
              {
                kind: 'create-plan-tool-call',
                status: 'done',
              },
            ],
          },
          { kind: 'message', role: 'assistant', text: 'Dosyalar düzenlendi.' },
        ],
        outcome: { kind: 'done' },
      },
    ];

    const ctx = extractPromptSuggestionContext(turns);
    expect(ctx?.activity).toEqual({
      outcome: 'done',
      editedFiles: ['src/core/voice.ts', 'src/core/voice.test.ts'],
      readFilesCount: 1,
      executedCommands: [
        { command: 'pnpm test' },
        { command: 'pnpm tsgo', failed: true },
      ],
      createdPlan: true,
      failedToolsCount: 1,
    });
  });

  it('iptal edilen turda asistan yanıtı boş olsa bile bağlam üretir', () => {
    const turns: SuggestionTurn[] = [
      {
        id: 't3',
        items: [{ kind: 'message', role: 'user', text: 'Devam et' }],
        outcome: { kind: 'cancelled' },
      },
    ];

    const ctx = extractPromptSuggestionContext(turns);
    expect(ctx).toEqual({
      turnId: 't3',
      outcome: 'cancelled',
      lastUserText: 'Devam et',
      lastAssistantText: '',
      activity: { outcome: 'cancelled' },
    });
  });
});
