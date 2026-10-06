import { describe, expect, it } from 'vitest';
import { buildFixPrompt } from './fix-prompt';
import { parseReviewReport } from './review-findings';
import {
  pickDefaultReviewer,
  pickMainConversation,
  rankMainConversationCandidates,
} from './review-participants';

describe('pickMainConversation', () => {
  const base = { providerId: 'claude', type: 'acp' as const };

  it('skips review and orchestra worker conversations', () => {
    const main = pickMainConversation([
      { ...base, id: 'r', title: 'İnceleme: son commit', lastInteractedAt: '2026-01-03' },
      { ...base, id: 'w', title: '🎼 Codex · iş', lastInteractedAt: '2026-01-02' },
      { ...base, id: 'm', title: 'Claude', lastInteractedAt: '2026-01-01' },
    ]);
    expect(main?.id).toBe('m');
  });

  it('prefers ACP, then the initial conversation, then the most recent', () => {
    const ranked = rankMainConversationCandidates([
      { ...base, id: 'pty', title: 'Terminal', type: 'pty', isInitialConversation: true },
      { ...base, id: 'old', title: 'A', lastInteractedAt: '2026-01-01' },
      { ...base, id: 'new', title: 'B', lastInteractedAt: '2026-02-01' },
      { ...base, id: 'initial', title: 'C', isInitialConversation: true },
    ]);
    expect(ranked.map((conversation) => conversation.id)).toEqual(['initial', 'new', 'old', 'pty']);
  });

  it('returns null without candidates', () => {
    expect(pickMainConversation([])).toBeNull();
  });
});

describe('pickDefaultReviewer', () => {
  it('prefers a different provider than the main conversation', () => {
    expect(
      pickDefaultReviewer(
        [
          { providerId: 'claude', models: ['opus', 'sonnet'] },
          { providerId: 'codex', models: [] },
        ],
        { providerId: 'claude', model: 'opus' }
      )
    ).toEqual({ providerId: 'codex', model: null });
  });

  it('falls back to a different model of the same provider', () => {
    expect(
      pickDefaultReviewer([{ providerId: 'claude', models: ['opus', 'sonnet'] }], {
        providerId: 'claude',
        model: 'opus',
      })
    ).toEqual({ providerId: 'claude', model: 'sonnet' });
  });

  it('uses the first candidate without a main conversation', () => {
    expect(pickDefaultReviewer([{ providerId: 'codex', models: [] }], null)).toEqual({
      providerId: 'codex',
      model: null,
    });
    expect(pickDefaultReviewer([], null)).toBeNull();
  });
});

describe('buildFixPrompt', () => {
  const { findings } = parseReviewReport(`FINDING 1
Severity: low
Location: b.ts:2
Summary: Nit.
FINDING 2
Severity: critical
Location: a.ts:1-3
Summary: Crash.
Failure scenario: Null input.
Suggested fix: Guard it.`);

  it('lists the selected findings by severity for the main conversation', () => {
    const prompt = buildFixPrompt(findings, {
      target: 'main',
      reviewTitle: 'İnceleme: son commit',
    });
    expect(prompt).toContain('("İnceleme: son commit") reported the findings below');
    expect(prompt.indexOf('[CRITICAL] a.ts:1-3 — Crash.')).toBeLessThan(
      prompt.indexOf('[LOW] b.ts:2 — Nit.')
    );
    expect(prompt).toContain('   Failure scenario: Null input.');
    expect(prompt).toContain('   Suggested fix: Guard it.');
    expect(prompt).toContain('If one is not a real problem');
  });

  it('lifts the read-only restriction when the reviewer fixes its own findings', () => {
    expect(buildFixPrompt(findings, { target: 'reviewer' })).toContain(
      'the earlier read-only restriction no longer applies'
    );
  });
});
