import { describe, expect, it } from 'vitest';
import {
  BRIEF_REQUEST_MARKER,
  buildBriefRequestPrompt,
  chooseContextHandoffSource,
  composeContextHandoffContext,
  contextHandoffContinuePrompt,
  contextHandoffTranscriptDir,
  extractAgentBrief,
  fitTranscript,
  MIN_BRIEF_CHARS,
  selectUserMessagesVerbatim,
  type ContextHandoffContextInput,
  type HandoffTurnWithOutcome,
} from './context-handoff-package';

const LONG_BRIEF = `1. Amaç: ödeme modülünü taşımak.\n${'ayrıntı '.repeat(80)}`;

function userTurn(seq: number, text: string): HandoffTurnWithOutcome {
  return {
    id: `t${seq}`,
    seq,
    items: [
      { id: `u${seq}`, kind: 'message', role: 'user', text },
      { id: `a${seq}`, kind: 'message', role: 'assistant', text: `yanıt ${seq}` },
    ],
    outcome: { kind: 'done' },
  };
}

function briefTurn(
  promptId: string | undefined,
  assistant: string[],
  outcome: HandoffTurnWithOutcome['outcome'] = { kind: 'done' }
): HandoffTurnWithOutcome {
  return {
    id: 'brief',
    seq: 99,
    items: [
      {
        id: 'ub',
        kind: 'message',
        role: 'user',
        text: buildBriefRequestPrompt(),
        ...(promptId ? { promptId } : {}),
      },
      ...assistant.map((text, i) => ({ id: `ab${i}`, kind: 'message', role: 'assistant', text })),
    ],
    ...(outcome ? { outcome } : {}),
  };
}

describe('buildBriefRequestPrompt', () => {
  it('is a visible, marked request covering every required section', () => {
    const prompt = buildBriefRequestPrompt();
    expect(prompt.startsWith(BRIEF_REQUEST_MARKER)).toBe(true);
    for (const heading of [
      'Amaç ve başarı ölçütü',
      'birebir',
      'kararlar ve gerekçeleri',
      'doğrulananlar ve doğrulanmayanlar',
      'açık bıraktığın süreçler',
      'ilk adım',
      'yapılmaması gerekenler',
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('hiçbir dosyayı değiştirmeden');
  });
});

describe('extractAgentBrief', () => {
  it('finds the brief by prompt id and joins every assistant message of that turn', () => {
    const result = extractAgentBrief(
      [userTurn(1, 'ilk'), briefTurn('p-1', ['Giriş.', LONG_BRIEF])],
      'p-1'
    );
    expect(result).toEqual({ kind: 'ok', text: `Giriş.\n\n${LONG_BRIEF.trim()}` });
  });

  it('falls back to the request marker when the replayed history lost the prompt id', () => {
    expect(extractAgentBrief([briefTurn(undefined, [LONG_BRIEF])], 'p-1').kind).toBe('ok');
  });

  it('reports failures instead of passing on a bad brief', () => {
    expect(extractAgentBrief([userTurn(1, 'x')], 'p-1')).toEqual({
      kind: 'failed',
      reason: 'not-found',
    });
    expect(
      extractAgentBrief(
        [briefTurn('p', [LONG_BRIEF], { kind: 'error', message: 'context overflow' })],
        'p'
      )
    ).toEqual({ kind: 'failed', reason: 'error', detail: 'context overflow' });
    expect(extractAgentBrief([briefTurn('p', [LONG_BRIEF], { kind: 'cancelled' })], 'p')).toEqual({
      kind: 'failed',
      reason: 'cancelled',
    });
    expect(extractAgentBrief([briefTurn('p', [])], 'p')).toEqual({
      kind: 'failed',
      reason: 'empty',
    });
    expect(extractAgentBrief([briefTurn('p', ['x'.repeat(MIN_BRIEF_CHARS - 1)])], 'p')).toEqual({
      kind: 'failed',
      reason: 'too-short',
    });
  });
});

describe('selectUserMessagesVerbatim', () => {
  it('keeps every message verbatim in chronological order when it fits', () => {
    const result = selectUserMessagesVerbatim([
      userTurn(1, 'Testleri asla silme.'),
      userTurn(2, '  Türkçe yaz.  '),
    ]);
    expect(result.text).toBe('[1/2]\nTestleri asla silme.\n\n[2/2]\nTürkçe yaz.');
    expect(result).toMatchObject({ total: 2, included: 2, omitted: 0, clipped: 0 });
  });

  it('prefers the newest messages and says how many older ones were left out', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      userTurn(i + 1, `mesaj-${i + 1} ${'x'.repeat(80)}`)
    );
    const result = selectUserMessagesVerbatim(turns, 300);
    expect(result.included).toBeGreaterThan(0);
    expect(result.omitted).toBe(10 - result.included);
    expect(result.text).toContain('mesaj-10');
    expect(result.text).not.toContain('mesaj-1 ');
    expect(result.text).toContain(`En eski ${result.omitted} mesaj bütçe nedeniyle alınmadı`);
  });

  it('clips an overlong message from both ends and notes it', () => {
    const long = `BAŞ${'y'.repeat(10_000)}SON`;
    const result = selectUserMessagesVerbatim([userTurn(1, long)], 50_000, 1_000);
    expect(result.clipped).toBe(1);
    expect(result.text).toContain('BAŞ');
    expect(result.text).toContain('SON');
    expect(result.text).toContain('(kırpıldı)');
  });

  it('leaves out the brief request itself', () => {
    const result = selectUserMessagesVerbatim([userTurn(1, 'gerçek istek'), briefTurn('p', [])]);
    expect(result.total).toBe(1);
    expect(result.text).not.toContain(BRIEF_REQUEST_MARKER);
  });
});

describe('chooseContextHandoffSource', () => {
  it('prefers the agent brief and otherwise names the reason for the fallback', () => {
    expect(chooseContextHandoffSource({ kind: 'ok', text: 'NOT' }, 'ÖZET')).toEqual({
      kind: 'agent-brief',
      text: 'NOT',
    });
    expect(chooseContextHandoffSource({ kind: 'failed', reason: 'timeout' }, 'ÖZET')).toEqual({
      kind: 'heuristic',
      text: 'ÖZET',
      failure: 'önceki ajan devir notunu zamanında yazamadı',
    });
    expect(chooseContextHandoffSource({ kind: 'failed', reason: 'timeout' }, '  ')).toBeNull();
  });
});

describe('composeContextHandoffContext', () => {
  const base: ContextHandoffContextInput = {
    sourceTitle: 'Ödeme taşıma',
    sourceProviderLabel: 'Claude',
    source: { kind: 'agent-brief', text: 'AGENT-BRIEF' },
    userMessages: selectUserMessagesVerbatim([userTurn(1, 'Kullanıcı talimatı')]),
    openState: {
      draftText: 'yarım taslak',
      queuedPrompts: ['sıradaki iş'],
      planEntries: [
        { content: 'bitti adım', status: 'completed' },
        { content: 'açık adım', status: 'in_progress' },
      ],
      runningAgents: [{ name: 'araştırmacı', detail: 'API sürümlerini tara' }],
    },
    transcript: {
      kind: 'written',
      path: '/home/u/.orkestra/handoffs/n.md',
      hostLabel: 'x',
      truncated: false,
    },
  };

  it('lays out brief, verbatim user messages, open state and the transcript pointer in order', () => {
    const text = composeContextHandoffContext(base);
    const order = [
      '[Bağlam devri]',
      '## 1. Devir notu',
      'AGENT-BRIEF',
      '## 2. Kullanıcının mesajları',
      'Kullanıcı talimatı',
      '## 3. Açık durum',
      '[sürüyor] açık adım',
      'araştırmacı',
      'sıradaki iş',
      'yarım taslak',
      '## 4. Tam döküm',
      '/home/u/.orkestra/handoffs/n.md',
      'Devir paketi sonu.',
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain('bitti adım');
    expect(text).toContain('tahmin etme; önce bu dosyayı oku');
  });

  it('says plainly when it carries the automatic summary instead of the agent brief', () => {
    const text = composeContextHandoffContext({
      ...base,
      source: { kind: 'heuristic', text: 'OTOMATİK', failure: 'devir notu turu iptal edildi' },
      transcript: { kind: 'unavailable', reason: 'izin yok' },
    });
    expect(text).toContain('Önceki ajan devir notu yazamadı: devir notu turu iptal edildi');
    expect(text).toContain('OTOMATİK');
    expect(text).toContain('dosyaya yazılamadı (izin yok)');
  });

  it('never exceeds the budget and keeps the transcript pointer and rules', () => {
    const text = composeContextHandoffContext({
      ...base,
      source: { kind: 'agent-brief', text: 'b'.repeat(40_000) },
      userMessages: selectUserMessagesVerbatim(
        Array.from({ length: 30 }, (_, i) => userTurn(i, 'u'.repeat(900)))
      ),
      budget: 8_000,
    });
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain('/home/u/.orkestra/handoffs/n.md');
    expect(text).toContain('Devir paketi sonu.');
  });

  it('mentions the previous transcript when the source itself was a hand-over', () => {
    expect(
      composeContextHandoffContext({
        ...base,
        previousTranscriptPath: '/h/.orkestra/handoffs/o.md',
      })
    ).toContain('/h/.orkestra/handoffs/o.md');
  });
});

describe('transcript helpers', () => {
  it('places the transcript under the host home, outside any git working tree', () => {
    expect(contextHandoffTranscriptDir('/home/test')).toBe('/home/test/.orkestra/handoffs');
    expect(contextHandoffTranscriptDir('/Users/test/')).toBe('/Users/test/.orkestra/handoffs');
    expect(contextHandoffTranscriptDir('C:\\Users\\s')).toBe('C:\\Users\\s\\.orkestra\\handoffs');
  });

  it('drops the oldest part of an oversized transcript and says so', () => {
    const fitted = fitTranscript(`ESKİ${'z'.repeat(5_000)}YENİ`, 4_000);
    expect(fitted.truncated).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(1_000);
    expect(fitted.text).toContain('YENİ');
    expect(fitted.text).not.toContain('ESKİ');
    expect(fitTranscript('kısa').truncated).toBe(false);
  });

  it('makes the fallback visible in the first message of the new conversation', () => {
    expect(contextHandoffContinuePrompt({ kind: 'agent-brief', text: '' })).not.toContain(
      'otomatik özet'
    );
    expect(contextHandoffContinuePrompt({ kind: 'heuristic', text: '', failure: 'x' })).toContain(
      'otomatik özet'
    );
  });
});
