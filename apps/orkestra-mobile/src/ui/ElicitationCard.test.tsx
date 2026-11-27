import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@/core/elicitation-schema';
import type { TranscriptEntry } from '@/core/mappers';
import { foldMobileEntries } from '@/core/turn-fold';
import {
  extractActiveTurnStartedAt,
  extractMobilePromptSuggestionContext,
  isElicitationAnswerEntry,
  positionActivePlanRows,
  shouldShowMobileWorkingIndicator,
  stopReasonBannerText,
} from './chat-helpers';
import { ElicitationCard } from './ElicitationCard';

describe('ElicitationCard', () => {
  it('renders nothing when queue is empty', () => {
    const html = renderToStaticMarkup(
      <ElicitationCard requests={[]} onResolve={() => undefined} />
    );
    expect(html).toBe('');
  });

  it('hides bottom Gönder button on single-select when no custom text is typed and renders inline custom input', () => {
    const req: ElicitationRequestView = {
      requestId: 'req-1',
      mode: 'form',
      message: 'Hangi ortam?',
      requestedSchema: {
        type: 'object',
        required: ['env'],
        properties: {
          env: {
            type: 'string',
            description: 'Hangi ortamda çalıştıralım?',
            oneOf: [
              { const: 'dev', title: '(Önerilen) Geliştirme - Hızlı yerel test' },
              { const: 'prod', title: 'Üretim' },
            ],
          },
          env_other: {
            type: 'string',
            description: 'Diğer',
          },
        },
      },
    };

    const html = renderToStaticMarkup(
      <ElicitationCard requests={[req]} onResolve={() => undefined} />
    );
    expect(html).toContain('Hangi ortamda çalıştıralım?');
    expect(html).toContain('Geliştirme');
    expect(html).toContain('Önerilen');
    expect(html).toContain('Başka bir şey yaz…');
    expect(html).toContain('Atla');
    expect(html).not.toContain('>Gönder<');
    expect(html).not.toContain('>Devam<');
  });

  it('renders checkboxes, queue counter, step navigator and Devam button on multi-question multi-select', () => {
    const req1: ElicitationRequestView = {
      requestId: 'req-multi',
      mode: 'form',
      message: 'Seçenekler',
      requestedSchema: {
        type: 'object',
        required: ['features', 'confirm'],
        properties: {
          features: {
            type: 'array',
            description: 'Hangi özellikleri ekleyelim?',
            items: { enum: ['Auth', 'Dark mode'] },
          },
          features_other: { type: 'string' },
          confirm: { type: 'boolean', description: 'Onaylıyor musun?' },
        },
      },
    };
    const req2: ElicitationRequestView = {
      requestId: 'req-2',
      mode: 'url',
      message: 'OAuth linkini aç',
      url: 'https://example.com/auth',
    };

    const html = renderToStaticMarkup(
      <ElicitationCard requests={[req1, req2]} onResolve={() => undefined} />
    );
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('1 / 2');
    expect(html).toContain('1/2');
    expect(html).toContain('Başka bir şey ekle…');
    expect(html).toContain('Devam');
  });

  it('renders url mode with external link and Tamamladım button', () => {
    const req: ElicitationRequestView = {
      requestId: 'req-url',
      mode: 'url',
      message: 'Devam etmek için oturum aç.',
      url: 'https://example.com/login',
    };

    const html = renderToStaticMarkup(
      <ElicitationCard requests={[req]} onResolve={() => undefined} />
    );
    expect(html).toContain('https://example.com/login');
    expect(html).toContain('Tamamladım');
    expect(html).toContain('Atla');
  });
});

describe('chat-helpers', () => {
  it('allows live working indicator on empty transcript and when only a plan entry is present', () => {
    expect(shouldShowMobileWorkingIndicator([], true)).toBe(true);
    const planOnly: TranscriptEntry[] = [
      { kind: 'message', id: 'u1', role: 'user', text: 'Başla' },
      {
        kind: 'plan',
        id: 'p1',
        entries: [{ id: 's1', content: 'Adım 1', status: 'in_progress' }],
        streaming: true,
        text: 'Adım 1',
      },
    ];
    expect(shouldShowMobileWorkingIndicator(planOnly, true)).toBe(true);

    const activeThink: TranscriptEntry[] = [
      ...planOnly,
      { kind: 'thinking', id: 't1', text: '', active: true, startedAt: 1000 },
    ];
    expect(shouldShowMobileWorkingIndicator(activeThink, true)).toBe(false);

    const runningTool: TranscriptEntry[] = [
      ...planOnly,
      {
        kind: 'tool',
        id: 'tool1',
        title: 'Komut',
        status: 'running',
        detail: 'pnpm test',
        children: [],
      },
    ];
    expect(shouldShowMobileWorkingIndicator(runningTool, true)).toBe(false);
  });

  it('repositions active turn plan card right above trailing active thinking row', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'message', id: 'u1', role: 'user', text: 'Plan yap' },
      {
        kind: 'plan',
        id: 'p1',
        entries: [{ id: '1', content: 'İncele', status: 'in_progress' }],
        streaming: true,
        text: 'İncele',
      },
      { kind: 'tool', id: 't1', title: 'Oku', status: 'done', detail: 'a.ts', children: [] },
      { kind: 'thinking', id: 'th1', text: '', active: true, startedAt: 5000 },
    ];
    const rows = foldMobileEntries(entries, {
      isWorking: true,
      searchActive: false,
      expandedFoldIds: new Set(),
    });
    const positioned = positionActivePlanRows(rows, true);
    const ids = positioned.map((r) => (r.kind === 'entry' ? r.entry.id : r.id));
    expect(ids).toEqual(['u1', 't1', 'p1', 'th1']);
  });

  it('extracts turn startedAt from session activity first, then active turn metadata', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'message', id: 'u1', role: 'user', text: 'Selam', turnStartedAt: 12345 },
    ];
    expect(
      extractActiveTurnStartedAt(entries, { turnStartedAt: 99999, lastActivityAt: 100000 })
    ).toBe(99999);
    expect(extractActiveTurnStartedAt(entries, null)).toBe(12345);
  });

  it('detects elicitation answer messages and extracts prompt suggestion context', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'message', id: 'u1', role: 'user', text: 'Testleri düzelt' },
      { kind: 'message', id: 'elicit-1', role: 'user', text: '**Soru**\nEvet' },
      {
        kind: 'tool',
        id: 'tool1',
        title: 'Düzenle',
        toolKind: 'modify-file-tool-call',
        status: 'done',
        detail: 'src/app.ts',
        children: [],
      },
      { kind: 'message', id: 'a1', role: 'assistant', text: 'Düzeltildi ve testler geçti.' },
    ];
    expect(isElicitationAnswerEntry(entries[1]!)).toBe(true);
    expect(isElicitationAnswerEntry(entries[0]!)).toBe(false);

    const ctx = extractMobilePromptSuggestionContext(entries, 'conv-1');
    expect(ctx).not.toBeNull();
    expect(ctx?.input.lastUserText).toBe('Testleri düzelt');
    expect(ctx?.input.lastAssistantText).toBe('Düzeltildi ve testler geçti.');
    expect(ctx?.input.activity?.editedFiles).toEqual(['src/app.ts']);
  });

  it('maps stop reasons to concise Turkish warnings', () => {
    expect(stopReasonBannerText('max_tokens')).toContain('token');
    expect(stopReasonBannerText('max_turn_requests')).toContain('istek');
    expect(stopReasonBannerText('refusal')).toContain('reddetti');
    expect(stopReasonBannerText('end_turn')).toBeNull();
  });
});
