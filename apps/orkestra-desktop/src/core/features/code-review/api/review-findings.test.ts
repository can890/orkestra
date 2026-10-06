import { describe, expect, it } from 'vitest';
import { normalizeVerdict, parseLocation, parseReviewReport } from './review-findings';
import { findLatestReviewReport } from './review-transcript';

const CANONICAL = `I looked at the diff and the callers.

FINDING 1
Severity: high
Location: src/core/a.ts:42
Summary: The cache key ignores the host.
Failure scenario: Two SSH hosts with the same path share one entry,
so the second host reads stale data.
Suggested fix: Include the host ref in the key.

FINDING 2
Severity: low
Location: src/core/b.ts:7-12
Summary: Duplicated helper.
Failure scenario: None at runtime.
Suggested fix: Reuse formatHostRef.

VERDICT: request-changes
Rationale: The cache bug returns wrong data.`;

describe('parseReviewReport', () => {
  it('parses the canonical format', () => {
    const report = parseReviewReport(CANONICAL);
    expect(report.structured).toBe(true);
    expect(report.verdict).toBe('request-changes');
    expect(report.verdictRationale).toBe('The cache bug returns wrong data.');
    expect(report.noFindings).toBe(false);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({
      index: 1,
      severity: 'high',
      file: 'src/core/a.ts',
      line: 42,
      endLine: null,
      summary: 'The cache key ignores the host.',
      failureScenario:
        'Two SSH hosts with the same path share one entry,\nso the second host reads stale data.',
      suggestedFix: 'Include the host ref in the key.',
    });
    expect(report.findings[1]).toMatchObject({ severity: 'low', line: 7, endLine: 12 });
  });

  it('produces stable ids for the same report', () => {
    const first = parseReviewReport(CANONICAL).findings.map((finding) => finding.id);
    const second = parseReviewReport(CANONICAL).findings.map((finding) => finding.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
  });

  it('tolerates markdown decoration, headings, bullets and synonyms', () => {
    const report = parseReviewReport(`## Findings

### Finding #1: Missing await
- **Severity:** Major
- **File:** \`src/x.ts:10\`
- **Impact:** The promise rejection is unhandled.
- **Fix:** Await the call.

### Finding 2 — Path traversal
* **Priority**: blocker
* **Location**: \`./src/y.ts\` (line 3)
* **Issue**: User input reaches path.join.
* **Recommendation**: Validate with the path-safety helper.

**Verdict:** Changes requested`);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({
      severity: 'high',
      file: 'src/x.ts',
      line: 10,
      summary: 'Missing await',
      failureScenario: 'The promise rejection is unhandled.',
      suggestedFix: 'Await the call.',
    });
    expect(report.findings[1]).toMatchObject({
      severity: 'critical',
      file: 'src/y.ts',
      line: 3,
      summary: 'User input reaches path.join.',
    });
    expect(report.verdict).toBe('request-changes');
  });

  it('accepts inline header details and numbered severity headers', () => {
    const report = parseReviewReport(`1. [Medium] src/a.ts:5 — Off by one in the loop
   Failure scenario: The last item is skipped.
2. [Nit] src/b.ts:9 - Rename variable

Verdict: comment`);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({
      severity: 'medium',
      file: 'src/a.ts',
      line: 5,
      summary: 'Off by one in the loop',
      failureScenario: 'The last item is skipped.',
    });
    expect(report.findings[1]).toMatchObject({ severity: 'low', summary: 'Rename variable' });
    expect(report.verdict).toBe('comment');
  });

  it('splits header-less blocks when a field repeats', () => {
    const report = parseReviewReport(`Severity: high
Location: a.ts:1
Summary: First.

Severity: low
Location: b.ts:2
Summary: Second.
VERDICT: approve`);
    expect(report.findings.map((finding) => finding.summary)).toEqual(['First.', 'Second.']);
    expect(report.verdict).toBe('approve');
  });

  it('ignores prose that merely uses a field label', () => {
    const report = parseReviewReport(`Summary: overall the change is clean.

NO FINDINGS

VERDICT: approve
Rationale: Nothing blocking.`);
    expect(report.findings).toEqual([]);
    expect(report.noFindings).toBe(true);
    expect(report.structured).toBe(true);
    expect(report.verdict).toBe('approve');
  });

  it('reads a verdict written on the line after a heading and strips code fences', () => {
    const report = parseReviewReport(
      '```\nFINDING 1\nSeverity: low\nLocation: c.ts:4\nSummary: Typo.\n```\n\n## Verdict\n**LGTM**'
    );
    expect(report.findings).toHaveLength(1);
    expect(report.verdict).toBe('approve');
  });

  it('defaults unknown severities to medium and keeps findings without a line', () => {
    const report = parseReviewReport(`FINDING 1
Severity: unclear
Location: README.md
Summary: Outdated instructions.`);
    expect(report.findings[0]).toMatchObject({ severity: 'medium', file: 'README.md', line: null });
  });

  it('reports unstructured text as such', () => {
    const report = parseReviewReport('I am still reading the diff…');
    expect(report).toEqual({
      findings: [],
      verdict: null,
      verdictRationale: null,
      noFindings: false,
      structured: false,
    });
    expect(parseReviewReport(undefined).structured).toBe(false);
  });
});

describe('parseLocation', () => {
  it.each([
    ['src/a.ts:42', { file: 'src/a.ts', line: 42, endLine: null }],
    ['`src/a.ts:42-50`', { file: 'src/a.ts', line: 42, endLine: 50 }],
    ['src/a.ts:42:7', { file: 'src/a.ts', line: 42, endLine: null }],
    ['src/a.ts#L9', { file: 'src/a.ts', line: 9, endLine: null }],
    ['src/a.ts, line 12', { file: 'src/a.ts', line: 12, endLine: null }],
    ['src/a.ts (lines 3-4)', { file: 'src/a.ts', line: 3, endLine: 4 }],
    ['b/src/a.ts:1', { file: 'src/a.ts', line: 1, endLine: null }],
    ['C:\\repo\\a.ts:5', { file: 'C:\\repo\\a.ts', line: 5, endLine: null }],
    ['src/a.ts', { file: 'src/a.ts', line: null, endLine: null }],
    ['somewhere in the parser', { file: null, line: null, endLine: null }],
  ])('parses %s', (input, expected) => {
    expect(parseLocation(input)).toEqual(expected);
  });
});

describe('normalizeVerdict', () => {
  it.each([
    ['request-changes', 'request-changes'],
    ['REQUEST CHANGES', 'request-changes'],
    ['Do not merge yet', 'request-changes'],
    ['approve', 'approve'],
    ['Approve with nits', 'comment'],
    ['comment', 'comment'],
    ['LGTM', 'approve'],
    ['maybe', null],
  ])('maps %s', (input, expected) => {
    expect(normalizeVerdict(input)).toBe(expected);
  });
});

describe('findLatestReviewReport', () => {
  const message = (role: 'user' | 'assistant', text: string) => ({ kind: 'message', role, text });

  it('returns the newest structured report, skipping follow-up chatter', () => {
    const located = findLatestReviewReport([
      {
        id: 't1',
        items: [message('user', 'Review'), message('assistant', CANONICAL)],
        outcome: { kind: 'done' },
      },
      {
        id: 't2',
        items: [message('user', 'Why?'), message('assistant', 'Because of the cache key.')],
      },
    ]);
    expect(located?.turnId).toBe('t1');
    expect(located?.settled).toBe(true);
    expect(located?.report.findings).toHaveLength(2);
  });

  it('marks a report from the active turn as unsettled', () => {
    const located = findLatestReviewReport(
      [
        {
          id: 't1',
          items: [message('assistant', 'FINDING 1\nSeverity: low\nLocation: a.ts:1\nSummary: x')],
        },
      ],
      { activeTurnId: 't1' }
    );
    expect(located?.settled).toBe(false);
  });

  it('returns null when no turn has a report', () => {
    expect(
      findLatestReviewReport([{ id: 't1', items: [message('assistant', 'Working on it')] }])
    ).toBeNull();
  });
});
