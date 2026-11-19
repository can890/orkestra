import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  applyBaseline,
  applyTrigger,
  buildAutoFixPrompt,
  collectFailedChecks,
  decideAutoFix,
  DEFAULT_PR_AUTOMATION_STATE,
  emptyLedger,
  MAX_AUTO_FIX_ATTEMPTS_PER_HEAD,
  MAX_AUTO_FIX_ATTEMPTS_PER_PR,
  MAX_AUTOMATION_EVENTS,
  prAutomationStateSchema,
  type AgentAvailability,
  type AutoFixComment,
  type AutoFixInput,
  type AutoFixPr,
  type PrAutomationLedger,
} from './pr-automation';

const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/orkestra/orkestra/pull/7';

function check(overrides: Partial<AutoFixPr['checks'][number]> = {}): AutoFixPr['checks'][number] {
  return {
    id: 'c1',
    pullRequestUrl: PR_URL,
    commitSha: HEAD,
    name: 'unit',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/orkestra/orkestra/actions/runs/1',
    startedAt: null,
    completedAt: null,
    workflowName: null,
    appName: null,
    appLogoUrl: null,
    ...overrides,
  };
}

function pr(overrides: Partial<AutoFixPr> = {}): AutoFixPr {
  return {
    url: PR_URL,
    status: 'open',
    isDraft: false,
    headRefOid: HEAD,
    authorUserId: 'github.com:me',
    checks: [check()],
    ...overrides,
  };
}

function comment(overrides: Partial<AutoFixComment> = {}): AutoFixComment {
  return {
    id: 'r1',
    kind: 'review',
    body: 'Bu satırı düzelt',
    url: `${PR_URL}#discussion_r1`,
    path: 'src/a.ts',
    line: 12,
    isResolved: false,
    isOutdated: false,
    authorUserId: 'github.com:reviewer',
    authorName: 'reviewer',
    ...overrides,
  };
}

function baselined(extra: Partial<PrAutomationLedger> = {}): PrAutomationLedger {
  return { ...emptyLedger(PR_URL), commentsBaselined: true, ...extra };
}

function input(overrides: Partial<AutoFixInput> = {}): AutoFixInput {
  return {
    enabled: true,
    pr: pr(),
    comments: { fetched: true, items: [] },
    agent: { kind: 'idle' } as AgentAvailability,
    ledger: baselined(),
    ...overrides,
  };
}

describe('collectFailedChecks', () => {
  it('yalnızca mevcut head SHA kontrollerini sayar', () => {
    const stale = check({ commitSha: 'b'.repeat(40), name: 'old' });
    expect(collectFailedChecks([stale], HEAD)).toEqual({ settled: false, failed: [] });
  });

  it('sürmekte olan kontrol varken yerleşmemiş sayar', () => {
    const result = collectFailedChecks(
      [check(), check({ id: 'c2', name: 'lint', status: 'IN_PROGRESS', conclusion: null })],
      HEAD
    );
    expect(result.settled).toBe(false);
    expect(result.failed.map((c) => c.name)).toEqual(['unit']);
  });

  it('iptal, atlanan ve başarılıları hata saymaz', () => {
    const result = collectFailedChecks(
      [
        check({ conclusion: 'SUCCESS' }),
        check({ id: 'c2', conclusion: 'CANCELLED' }),
        check({ id: 'c3', conclusion: 'SKIPPED' }),
      ],
      HEAD
    );
    expect(result).toEqual({ settled: true, failed: [] });
  });
});

describe('decideAutoFix', () => {
  it('kapalıyken hiçbir şey yapmaz (varsayılan durum kapalı)', () => {
    expect(DEFAULT_PR_AUTOMATION_STATE.autoFix).toBe(false);
    expect(decideAutoFix(input({ enabled: false }))).toEqual({
      action: 'skip',
      reason: 'disabled',
    });
  });

  it('kapalı/birleşmiş PR ve taslak PR için tetiklemez', () => {
    expect(decideAutoFix(input({ pr: pr({ status: 'merged' }) }))).toEqual({
      action: 'skip',
      reason: 'pr-not-open',
    });
    expect(decideAutoFix(input({ pr: pr({ status: 'closed' }) }))).toEqual({
      action: 'skip',
      reason: 'pr-not-open',
    });
    expect(decideAutoFix(input({ pr: pr({ isDraft: true }) }))).toEqual({
      action: 'skip',
      reason: 'pr-draft',
    });
  });

  it('başarısız kontrol yerleşince tetikler', () => {
    const decision = decideAutoFix(input());
    expect(decision).toMatchObject({ action: 'trigger', reviewComments: [] });
    if (decision.action !== 'trigger') throw new Error('trigger bekleniyordu');
    expect(decision.failedChecks).toEqual([
      expect.objectContaining({ name: 'unit', conclusion: 'FAILURE' }),
    ]);
    expect(decision.fingerprints).toEqual(['checks:unit|FAILURE']);
  });

  it('kontroller sürerken ya da head için kontrol yokken beklemeye geçer', () => {
    const running = pr({
      checks: [check(), check({ id: 'c2', name: 'e2e', status: 'QUEUED', conclusion: null })],
    });
    expect(decideAutoFix(input({ pr: running }))).toEqual({
      action: 'skip',
      reason: 'checks-pending',
    });
    expect(decideAutoFix(input({ pr: pr({ checks: [] }) }))).toEqual({
      action: 'skip',
      reason: 'checks-pending',
    });
  });

  it('kontroller geçiyorsa ve yorum yoksa yapacak bir şey yoktur', () => {
    expect(
      decideAutoFix(input({ pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }) }))
    ).toEqual({ action: 'skip', reason: 'nothing-to-fix' });
  });

  it('ajan meşgulken tetiklemez, ajan yokken tetiklemez', () => {
    expect(decideAutoFix(input({ agent: { kind: 'busy' } }))).toEqual({
      action: 'skip',
      reason: 'agent-busy',
    });
    expect(decideAutoFix(input({ agent: { kind: 'none' } }))).toEqual({
      action: 'skip',
      reason: 'no-conversation',
    });
  });

  it('aynı hatayı iki kez işlemez', () => {
    const first = decideAutoFix(input());
    if (first.action !== 'trigger') throw new Error('trigger bekleniyordu');
    const ledger = applyTrigger(baselined(), PR_URL, HEAD, first);
    expect(decideAutoFix(input({ ledger }))).toEqual({
      action: 'skip',
      reason: 'already-handled',
    });
    // Ajan push etti: yeni SHA, aynı kontrol aynı nedenle kırık -> yine işlenmez.
    const nextHead = 'c'.repeat(40);
    const next = pr({
      headRefOid: nextHead,
      checks: [check({ commitSha: nextHead })],
    });
    expect(decideAutoFix(input({ pr: next, ledger }))).toEqual({
      action: 'skip',
      reason: 'already-handled',
    });
  });

  it('farklı bir kontrol kümesi kırılırsa yeni hata sayılır', () => {
    const first = decideAutoFix(input());
    if (first.action !== 'trigger') throw new Error('trigger bekleniyordu');
    const ledger = applyTrigger(baselined(), PR_URL, HEAD, first);
    const other = pr({ checks: [check({ name: 'lint' })] });
    expect(decideAutoFix(input({ pr: other, ledger }))).toMatchObject({ action: 'trigger' });
  });

  it('aynı head SHA için en fazla 3 deneme yapar', () => {
    // Her denemede farklı bir yorum: parmak izi aynı değil, ama SHA sınırı geçerli.
    let ledger = baselined();
    for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS_PER_HEAD; i += 1) {
      const decision = decideAutoFix(
        input({
          ledger,
          pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
          comments: { fetched: true, items: [comment({ id: `r${i}` })] },
        })
      );
      expect(decision.action).toBe('trigger');
      if (decision.action !== 'trigger') return;
      ledger = applyTrigger(ledger, PR_URL, HEAD, decision);
    }
    expect(
      decideAutoFix(
        input({
          ledger,
          pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
          comments: { fetched: true, items: [comment({ id: 'rNew' })] },
        })
      )
    ).toEqual({ action: 'skip', reason: 'head-attempt-limit' });
  });

  it('yeni SHA için head sayacı sıfırdan başlar ama PR toplam tavanı geçerlidir', () => {
    const exhaustedHead = baselined({
      attemptsByHead: { [HEAD]: MAX_AUTO_FIX_ATTEMPTS_PER_HEAD },
      totalAttempts: 3,
    });
    const nextHead = 'd'.repeat(40);
    const next = pr({
      headRefOid: nextHead,
      checks: [check({ commitSha: nextHead, name: 'lint' })],
    });
    expect(decideAutoFix(input({ pr: next, ledger: exhaustedHead }))).toMatchObject({
      action: 'trigger',
    });
    const capped = baselined({ totalAttempts: MAX_AUTO_FIX_ATTEMPTS_PER_PR });
    expect(decideAutoFix(input({ pr: next, ledger: capped }))).toEqual({
      action: 'skip',
      reason: 'pr-attempt-limit',
    });
  });

  it('başka PR için tutulan defteri yok sayar', () => {
    const other = { ...baselined({ totalAttempts: 99 }), prUrl: 'https://github.com/o/r/pull/1' };
    const decision = decideAutoFix(input({ ledger: other }));
    // Defter başka PR'a ait: baz çizgisi yeniden alınır.
    expect(decision).toEqual({ action: 'baseline', commentIds: [] });
  });

  describe('inceleme yorumları', () => {
    it('yorumlar ilk yüklenince mevcutları görüldü sayar, tetiklemez', () => {
      const decision = decideAutoFix(
        input({
          ledger: emptyLedger(PR_URL),
          pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
          comments: { fetched: true, items: [comment({ id: 'old1' }), comment({ id: 'old2' })] },
        })
      );
      expect(decision).toEqual({ action: 'baseline', commentIds: ['old1', 'old2'] });
      const ledger = applyBaseline(emptyLedger(PR_URL), PR_URL, ['old1', 'old2']);
      expect(ledger.commentsBaselined).toBe(true);
      expect(
        decideAutoFix(
          input({
            ledger,
            pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
            comments: { fetched: true, items: [comment({ id: 'old1' })] },
          })
        )
      ).toEqual({ action: 'skip', reason: 'nothing-to-fix' });
    });

    it('yorumlar henüz yüklenmediyse baz çizgisi almaz ve yorumdan tetiklemez', () => {
      expect(
        decideAutoFix(
          input({
            ledger: emptyLedger(PR_URL),
            pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
            comments: { fetched: false, items: [] },
          })
        )
      ).toEqual({ action: 'skip', reason: 'nothing-to-fix' });
    });

    it('yeni, çözülmemiş inceleme yorumunda tetikler', () => {
      const decision = decideAutoFix(
        input({
          pr: pr({ checks: [check({ conclusion: 'SUCCESS' })] }),
          comments: { fetched: true, items: [comment({ id: 'new1' })] },
        })
      );
      expect(decision).toMatchObject({
        action: 'trigger',
        failedChecks: [],
        fingerprints: ['comment:new1'],
      });
    });

    it('çözülmüş, eskimiş, issue türü ve PR yazarının yorumlarını yok sayar', () => {
      const ok = pr({ checks: [check({ conclusion: 'SUCCESS' })] });
      const items = [
        comment({ id: 'a', isResolved: true }),
        comment({ id: 'b', isOutdated: true }),
        comment({ id: 'c', kind: 'issue' }),
        comment({ id: 'd', authorUserId: 'github.com:me' }),
      ];
      expect(decideAutoFix(input({ pr: ok, comments: { fetched: true, items } }))).toEqual({
        action: 'skip',
        reason: 'nothing-to-fix',
      });
    });

    it('aynı yorumu iki kez işlemez', () => {
      const ok = pr({ checks: [check({ conclusion: 'SUCCESS' })] });
      const comments = { fetched: true, items: [comment({ id: 'x' })] };
      const first = decideAutoFix(input({ pr: ok, comments }));
      if (first.action !== 'trigger') throw new Error('trigger bekleniyordu');
      const ledger = applyTrigger(baselined(), PR_URL, HEAD, first);
      expect(decideAutoFix(input({ pr: ok, comments, ledger }))).toEqual({
        action: 'skip',
        reason: 'nothing-to-fix',
      });
    });

    it('hata ve yorum birlikte tek tetiklemede toplanır', () => {
      const decision = decideAutoFix(
        input({ comments: { fetched: true, items: [comment({ id: 'z' })] } })
      );
      expect(decision).toMatchObject({
        action: 'trigger',
        fingerprints: ['checks:unit|FAILURE', 'comment:z'],
      });
    });
  });
});

describe('applyTrigger', () => {
  it('sayaçları ve işlenmiş parmak izlerini günceller, eski SHA kayıtlarını budar', () => {
    let ledger = baselined();
    for (let i = 0; i < 12; i += 1) {
      const head = String(i).padStart(40, '0');
      ledger = applyTrigger(ledger, PR_URL, head, {
        action: 'trigger',
        failedChecks: [],
        reviewComments: [],
        fingerprints: [`checks:n${i}|FAILURE`],
      });
    }
    expect(ledger.totalAttempts).toBe(12);
    expect(Object.keys(ledger.attemptsByHead).length).toBeLessThanOrEqual(10);
    expect(ledger.handled).toContain('checks:n11|FAILURE');
  });
});

describe('buildAutoFixPrompt', () => {
  it('kontrol ve yorumları veri olarak alıntılar, kırpar ve güvenlik talimatı ekler', () => {
    const long = 'x'.repeat(5_000);
    const text = buildAutoFixPrompt(
      { url: PR_URL, headRefOid: HEAD },
      {
        action: 'trigger',
        failedChecks: [{ name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://x/y' }],
        reviewComments: [comment({ body: long })],
        fingerprints: [],
      }
    );
    expect(text).toContain(PR_URL);
    expect(text).toContain('unit (FAILURE) https://x/y');
    expect(text).toContain('src/a.ts:12');
    expect(text).toContain('Force-push yapma');
    expect(text.length).toBeLessThan(3_500);
  });
});

describe('durum şeması ve olay günlüğü', () => {
  it('varsayılan durum şemaya uyar ve her şey kapalıdır', () => {
    expect(prAutomationStateSchema.safeParse(DEFAULT_PR_AUTOMATION_STATE).success).toBe(true);
    expect(DEFAULT_PR_AUTOMATION_STATE.autoFix).toBe(false);
    expect(DEFAULT_PR_AUTOMATION_STATE.autoMerge).toBeNull();
  });

  it('olay günlüğü sınırlıdır', () => {
    let events: ReturnType<typeof appendEvent> = [];
    for (let i = 0; i < MAX_AUTOMATION_EVENTS + 5; i += 1) {
      events = appendEvent(events, { at: i, kind: 'sent', headSha: HEAD, summary: String(i) });
    }
    expect(events).toHaveLength(MAX_AUTOMATION_EVENTS);
    expect(events.at(-1)?.at).toBe(MAX_AUTOMATION_EVENTS + 4);
  });
});
