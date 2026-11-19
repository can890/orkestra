import { makeAutoObservable, observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PR_AUTOMATION_STATE,
  MAX_AUTO_FIX_ATTEMPTS_PER_HEAD,
  type AgentAvailability,
  type AutoFixComment,
  type AutoFixPr,
  type PrAutomationState,
} from '../../pr-automation';
import {
  PrAutomationStore,
  type PrAutomationHandle,
  type PrAutomationPorts,
  type PrAutomationSnapshot,
} from './pr-automation-store';

const PR_URL = 'https://github.com/orkestra/orkestra/pull/7';
const HEAD = 'a'.repeat(40);

class FakeHandle implements PrAutomationHandle {
  value: PrAutomationState = DEFAULT_PR_AUTOMATION_STATE;
  readonly ready = Promise.resolve();
  constructor() {
    makeAutoObservable(this, { ready: false, value: observable.ref });
  }
  update(next: (current: PrAutomationState) => PrAutomationState): void {
    this.value = next(this.value);
  }
}

function failingPr(head = HEAD, name = 'unit'): AutoFixPr {
  return {
    url: PR_URL,
    status: 'open',
    isDraft: false,
    headRefOid: head,
    authorUserId: 'github.com:me',
    checks: [
      {
        id: `${head}-${name}`,
        pullRequestUrl: PR_URL,
        commitSha: head,
        name,
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        workflowName: null,
        appName: null,
        appLogoUrl: null,
      },
    ],
  };
}

function reviewComment(id: string): AutoFixComment {
  return {
    id,
    kind: 'review',
    body: 'Düzelt',
    url: `${PR_URL}#r${id}`,
    path: 'a.ts',
    line: 1,
    isResolved: false,
    isOutdated: false,
    authorUserId: 'github.com:reviewer',
    authorName: 'reviewer',
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const stores: PrAutomationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function harness(initial?: { snapshot?: PrAutomationSnapshot | null; agent?: AgentAvailability }) {
  const handle = new FakeHandle();
  const env = observable(
    {
      snapshot:
        initial?.snapshot === undefined
          ? ({
              pr: failingPr(),
              comments: { fetched: false, items: [] },
            } as PrAutomationSnapshot | null)
          : initial.snapshot,
      agent: (initial?.agent ?? { kind: 'idle' }) as AgentAvailability,
    },
    { snapshot: observable.ref, agent: observable.ref }
  );
  const sendPrompt = vi.fn<PrAutomationPorts['sendPrompt']>(async () => ({ success: true }));
  const report = { sent: vi.fn(), failed: vi.fn(), blocked: vi.fn() };
  const store = new PrAutomationStore({
    handle,
    read: () => env.snapshot,
    agent: () => env.agent,
    sendPrompt,
    now: () => 1_000,
    report,
  });
  stores.push(store);
  store.start();
  return {
    store,
    handle,
    sendPrompt,
    report,
    setAgent: (agent: AgentAvailability) => runInAction(() => (env.agent = agent)),
    setSnapshot: (snapshot: PrAutomationSnapshot | null) =>
      runInAction(() => (env.snapshot = snapshot)),
  };
}

describe('PrAutomationStore', () => {
  it('varsayılan olarak kapalıdır ve hata görse de ajana mesaj göndermez', async () => {
    const h = harness();
    await flush();
    expect(h.store.autoFix).toBe(false);
    expect(h.sendPrompt).not.toHaveBeenCalled();
  });

  it('açılınca başarısız kontrolü tek kez gönderir ve etkinliğe yazar', async () => {
    const h = harness();
    await flush();
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.sendPrompt.mock.calls[0]?.[0]).toContain('unit (FAILURE)');
    expect(h.report.sent).toHaveBeenCalledWith('1 başarısız kontrol');
    expect(h.store.events).toEqual([
      { at: 1_000, kind: 'sent', headSha: HEAD, summary: '1 başarısız kontrol' },
    ]);
    // Aynı hata ikinci kez işlenmez: yeniden değerlendirme (yeni nesne) mesaj göndermez.
    h.setSnapshot({ pr: failingPr(), comments: { fetched: false, items: [] } });
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('ajan meşgulken bekler, boşa çıkınca gönderir', async () => {
    const h = harness({ agent: { kind: 'busy' } });
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).not.toHaveBeenCalled();
    h.setAgent({ kind: 'idle' });
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('gönderim başarısız olsa da deneme harcanır ve tekrar denenmez', async () => {
    const h = harness();
    h.sendPrompt.mockResolvedValue({ success: false, error: 'oturum yok' });
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.report.failed).toHaveBeenCalledWith('1 başarısız kontrol', 'oturum yok');
    expect(h.store.events[0]).toMatchObject({ kind: 'send-failed' });
    h.setSnapshot({ pr: failingPr(), comments: { fetched: false, items: [] } });
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('aynı head için en fazla 3 deneme yapar ve sınırı bir kez bildirir', async () => {
    const h = harness({
      snapshot: {
        pr: { ...failingPr(), checks: [] },
        comments: { fetched: true, items: [] },
      },
    });
    h.store.setAutoFix(true);
    await flush(); // baz çizgisi
    for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS_PER_HEAD + 2; i += 1) {
      h.setSnapshot({
        pr: { ...failingPr(), checks: [] },
        comments: { fetched: true, items: [reviewComment(`c${i}`)] },
      });
      await flush();
    }
    expect(h.sendPrompt).toHaveBeenCalledTimes(MAX_AUTO_FIX_ATTEMPTS_PER_HEAD);
    expect(h.report.blocked).toHaveBeenCalledTimes(1);
    expect(h.store.events.filter((event) => event.kind === 'blocked')).toHaveLength(1);
  });

  it('açmadan önce var olan yorumlar tetiklemez, sonradan gelenler tetikler', async () => {
    const noFailures: AutoFixPr = { ...failingPr(), checks: [] };
    const h = harness({
      snapshot: { pr: noFailures, comments: { fetched: true, items: [reviewComment('old')] } },
    });
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).not.toHaveBeenCalled();
    h.setSnapshot({
      pr: noFailures,
      comments: { fetched: true, items: [reviewComment('old'), reviewComment('new')] },
    });
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    expect(h.sendPrompt.mock.calls[0]?.[0]).toContain('#rnew');
    expect(h.sendPrompt.mock.calls[0]?.[0]).not.toContain('#rold');
  });

  it('kapatılınca durur; yeniden açmak defteri sıfırlar', async () => {
    const h = harness();
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);
    h.store.setAutoFix(false);
    await flush();
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).toHaveBeenCalledTimes(2);
    expect(h.store.state.ledger.totalAttempts).toBe(1);
  });

  it('PR bilinmiyorsa hiçbir şey yapmaz', async () => {
    const h = harness({ snapshot: null });
    h.store.setAutoFix(true);
    await flush();
    expect(h.sendPrompt).not.toHaveBeenCalled();
  });

  it('auto-merge isteği PR adresine bağlıdır', () => {
    const h = harness();
    expect(h.store.autoMergeStrategyFor(PR_URL)).toBeNull();
    h.store.setAutoMergeIntent({ prUrl: PR_URL, strategy: 'squash' });
    expect(h.store.autoMergeStrategyFor(PR_URL)).toBe('squash');
    expect(h.store.autoMergeStrategyFor('https://github.com/o/r/pull/9')).toBeNull();
    h.store.setAutoMergeIntent(null);
    expect(h.store.autoMergeStrategyFor(PR_URL)).toBeNull();
  });
});
