import { describe, expect, it } from 'vitest';
import {
  buildTranscriptMarkdownFilename,
  formatTranscriptAsMarkdown,
} from './format-transcript-markdown';

describe('formatTranscriptAsMarkdown', () => {
  it('renders user messages, assistant replies, thinking, tool calls, diffs, and handoff dividers', () => {
    const md = formatTranscriptAsMarkdown({
      title: 'Auth Hata Düzeltme',
      providerId: 'claude',
      model: 'claude-sonnet-4-6',
      exportedAt: new Date('2026-11-24T12:00:00.000Z'),
      turns: [
        {
          id: 't-1',
          seq: 1,
          items: [
            {
              kind: 'message',
              id: 'm-1',
              seq: 1,
              role: 'user',
              text: 'Giriş hatasını düzeltir misin?',
            },
            {
              kind: 'thinking',
              id: 'th-1',
              seq: 2,
              status: 'done',
              text: 'Auth dosyasını incelemeliyim.',
              startedAt: 1000,
              durationMs: 1500,
            },
            {
              kind: 'execute-tool-call',
              id: 'ex-1',
              seq: 3,
              toolCallId: 'tc-1',
              title: 'pnpm test',
              command: 'pnpm test',
              outputText: 'All tests passed',
              status: 'done',
            },
            {
              kind: 'modify-file-tool-call',
              id: 'mod-1',
              seq: 4,
              toolCallId: 'tc-2',
              title: 'Edit auth.ts',
              path: 'src/auth.ts',
              oldText: 'return false;',
              newText: 'return true;',
              status: 'done',
            },
            {
              kind: 'message',
              id: 'm-2',
              seq: 5,
              role: 'assistant',
              text: 'Düzeltildi ve testler geçti.',
            },
          ],
          outcome: { kind: 'done', reason: 'end_turn' },
        },
        {
          id: 'handoff-divider:1',
          seq: -1,
          items: [
            {
              kind: 'handoff-divider',
              id: 'hd-1',
              fromProviderId: 'claude',
              fromLabel: 'Claude Code',
              toProviderId: 'codex',
              toLabel: 'Codex',
            },
          ],
        },
      ],
    });

    expect(md).toContain('# Auth Hata Düzeltme');
    expect(md).toContain('**Ajan:** claude · **Model:** claude-sonnet-4-6');
    expect(md).toContain('### Kullanıcı\n\nGiriş hatasını düzeltir misin?');
    expect(md).toContain('<summary>Düşünme (1.5 sn)</summary>');
    expect(md).toContain('`pnpm test`');
    expect(md).toContain('```diff\n- return false;\n+ return true;\n```');
    expect(md).toContain('### Asistan\n\nDüzeltildi ve testler geçti.');
    expect(md).toContain('> Ajan devri: **Claude Code** → **Codex**');
  });

  it('builds safe .md filenames', () => {
    expect(buildTranscriptMarkdownFilename('Twilio Giriş Hatası!')).toBe('twilio-giriş-hatası.md');
    expect(buildTranscriptMarkdownFilename('')).toBe('sohbet.md');
  });
});
