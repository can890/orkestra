import { describe, expect, it } from 'vitest';
import {
  mapAccounts,
  mapConversations,
  mapHistoryPage,
  mapProjects,
  mapSessionState,
  mapTasks,
  mapTurn,
  mapUsage,
} from './mappers';
import { TranscriptStore } from './transcript-store';

describe('mapProjects / mapTasks / mapConversations', () => {
  it('projeleri ada göre sıralar, bozuk girdilerde boş döner', () => {
    expect(mapProjects(undefined)).toEqual([]);
    const projects = mapProjects({
      projects: [
        { type: 'ssh', id: 'b', name: 'Zeta', path: '/z' },
        { type: 'local', id: 'a', name: 'Alfa', path: '/a' },
        { id: '' },
        'x',
      ],
    });
    expect(projects.map((p) => [p.id, p.remote])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('arşivlenmiş görevleri atar; sabitlenmişi öne, sonra son etkinliğe göre sıralar', () => {
    const tasks = mapTasks(
      {
        tasks: [
          { id: '1', name: 'eski', status: 'todo', updatedAt: '2026-01-01' },
          { id: '2', name: 'yeni', status: 'review', updatedAt: '2026-02-01' },
          { id: '3', name: 'sabit', status: 'weird', isPinned: true, updatedAt: '2025-01-01' },
          { id: '4', name: 'arşiv', status: 'done', archivedAt: '2026-03-01' },
        ],
      },
      'p'
    );
    expect(tasks.map((t) => t.id)).toEqual(['3', '2', '1']);
    expect(tasks[0]?.status).toBe('unknown');
  });

  it('yalnızca ACP sohbetlerini sürdürülebilir işaretler', () => {
    const list = mapConversations([
      { id: 'a', type: 'acp', title: 'Sohbet', lastInteractedAt: '2026-01-02' },
      { id: 'b', title: '', lastInteractedAt: null },
    ]);
    expect(list.map((c) => [c.id, c.chatCapable, c.title])).toEqual([
      ['a', true, 'Sohbet'],
      ['b', false, 'Adsız sohbet'],
    ]);
  });
});

describe('mapSessionState', () => {
  it('bekleyen izinleri ve etkin turu eşler', () => {
    const view = mapSessionState({
      lifecycle: 'working',
      isGenerating: true,
      canCancel: true,
      queuedPrompts: [{}, {}],
      historyRevision: 4,
      transcript: { generation: 'g', historyRevision: 4, activeTurn: { id: 't', items: [] } },
      pendingPermissions: [
        {
          requestId: 'r1',
          toolCall: { title: 'Komut çalıştır', command: 'ls -la' },
          options: [
            { optionId: 'o1', name: 'İzin ver', kind: 'allow_once' },
            { optionId: 'o2', name: 'Reddet', kind: 'reject_once' },
          ],
        },
      ],
    });
    expect(view).toMatchObject({
      lifecycle: 'working',
      queuedCount: 2,
      historyRevision: 4,
      generation: 'g',
    });
    expect(view.permissions[0]).toMatchObject({
      requestId: 'r1',
      title: 'Komut çalıştır',
      detail: 'ls -la',
    });
    expect(view.permissions[0]?.options.map((o) => o.allow)).toEqual([true, false]);
    expect(view.activeTurn).toEqual({ id: 't', items: [] });
  });

  it('bilinmeyen yaşam döngüsünde güvenli varsayılana düşer', () => {
    expect(mapSessionState(null).lifecycle).toBe('starting');
    expect(mapSessionState({ lifecycle: 'x' }).canSubmit).toBe(false);
  });
});

describe('mapTurn', () => {
  it('mesaj, düşünce, araç ve sonuç bildirimini döker', () => {
    const entries = mapTurn({
      id: 't1',
      seq: 1,
      items: [
        { kind: 'message', id: 'm1', role: 'user', text: 'Merhaba', promptId: 'p1' },
        { kind: 'thinking', id: 'th', text: '…', status: 'thinking' },
        {
          kind: 'execute-tool-call',
          id: 'x',
          title: 'Komut',
          command: 'pnpm test',
          status: 'running',
        },
        {
          kind: 'tool-group',
          id: 'g',
          label: '3 dosya okundu',
          status: 'done',
          children: [{ kind: 'read-tool-call', id: 'r', title: 'Oku', status: 'done' }],
        },
        { kind: 'message', id: 'm2', role: 'assistant', text: 'Selam' },
      ],
      outcome: { kind: 'error', message: 'Süreç kapandı' },
    });
    expect(entries.map((e) => e.kind)).toEqual([
      'message',
      'thinking',
      'tool',
      'tool',
      'message',
      'notice',
    ]);
    expect(entries[0]).toMatchObject({ promptId: 'p1' });
    expect(entries[2]).toMatchObject({ detail: 'pnpm test', status: 'running' });
    expect(entries[3]).toMatchObject({ children: [{ kind: 'tool' }] });
    expect(entries[5]).toMatchObject({ tone: 'error', text: 'Süreç kapandı' });
  });

  it('iptal edilen turu bilgi olarak gösterir; tanınmayan öğeleri atlar', () => {
    const entries = mapTurn({
      id: 't',
      items: [{ kind: 'garip' }],
      outcome: { kind: 'cancelled' },
    });
    expect(entries).toEqual([
      { kind: 'notice', id: 't:outcome', tone: 'info', text: 'Tur iptal edildi.' },
    ]);
    expect(mapTurn('x')).toEqual([]);
  });
});

describe('TranscriptStore', () => {
  const turn = (seq: number, text: string) => ({
    id: `t${seq}`,
    seq,
    items: [{ kind: 'message', id: `m${seq}`, role: 'assistant', text }],
  });
  const page = (turns: unknown[], nextCursor: number | null, generation = 'g1') =>
    mapHistoryPage({ turns, nextCursor, position: { generation, historyRevision: 1 } });

  it('sayfaları seq sırasıyla birleştirir ve eski sayfa imlecini yönetir', () => {
    const store = new TranscriptStore();
    store.applyPage(page([turn(3, 'c'), turn(4, 'd')], 3), true);
    expect(store.hasOlder).toBe(true);
    store.applyPage(page([turn(1, 'a'), turn(2, 'b')], null), true);
    expect(store.hasOlder).toBe(false);
    expect(store.entries().map((e) => (e.kind === 'message' ? e.text : ''))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('en yeni sayfayı tazelerken eski sayfa imlecini bozmaz', () => {
    const store = new TranscriptStore();
    store.applyPage(page([turn(5, 'e')], 5), true);
    store.applyPage(page([turn(5, 'e2'), turn(6, 'f')], null), false);
    expect(store.olderCursor).toBe(5);
    expect(store.entries().map((e) => (e.kind === 'message' ? e.text : ''))).toEqual(['e2', 'f']);
  });

  it('generation değişince eski turları atar', () => {
    const store = new TranscriptStore();
    store.applyPage(page([turn(1, 'a')], null), true);
    const reset = store.applyPage(page([turn(1, 'yeni')], null, 'g2'), true);
    expect(reset).toBe(true);
    expect(store.entries()).toHaveLength(1);
  });

  it('etkin turu sona ekler, geçmişe girince yinelemez', () => {
    const store = new TranscriptStore();
    store.applyPage(page([turn(1, 'a')], null), true);
    store.setActiveTurn(turn(2, 'canlı'));
    expect(store.entries()).toHaveLength(2);
    store.applyPage(page([turn(2, 'kesin')], null), false);
    expect(store.entries().map((e) => (e.kind === 'message' ? e.text : ''))).toEqual([
      'a',
      'kesin',
    ]);
  });
});

describe('hesaplar ve kullanım', () => {
  it('bağlı hesapları durumlarıyla eşler (token alanı yok)', () => {
    const accounts = mapAccounts({
      codex: { providerId: 'codex', name: 'Codex', auth: { status: { kind: 'unauthenticated' } } },
      claude: {
        providerId: 'claude',
        name: 'Claude',
        auth: { status: { kind: 'authenticated', account: 'a@b.c' } },
      },
    });
    expect(accounts.map((a) => [a.providerId, a.auth, a.account])).toEqual([
      ['claude', 'authenticated', 'a@b.c'],
      ['codex', 'unauthenticated', null],
    ]);
  });

  it('kullanım pencerelerinin yüzdesini 0-100 aralığına sıkıştırır', () => {
    const usage = mapUsage({
      providers: [
        {
          providerId: 'claude',
          status: 'available',
          plan: 'Max',
          windows: [
            { label: '5 saat', usedPercent: 140, resetsAt: '2026-01-01T00:00:00Z' },
            { label: 'x' },
          ],
          balances: [{ label: 'Kredi', value: 3, unit: 'USD' }],
        },
      ],
    });
    expect(usage[0]?.windows.map((w) => w.usedPercent)).toEqual([100, 0]);
    expect(usage[0]?.balances[0]).toEqual({ label: 'Kredi', value: 3, unit: 'USD' });
  });
});
