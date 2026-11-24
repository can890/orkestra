import { describe, expect, it } from 'vitest';
import {
  buildActiveWorkList,
  buildMobileHandoffContext,
  mapAccounts,
  mapConversations,
  mapHandoffList,
  mapHandoffSuperseded,
  mapHistoryPage,
  mapProjects,
  mapSessionAgents,
  mapSessionConfig,
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

describe('hostRef ve buildActiveWorkList', () => {
  it('yerel ve SSH projeleri için doğru hostRef üretir', () => {
    const projects = mapProjects({
      projects: [
        { type: 'local', id: 'p1', name: 'Alfa', path: '/a' },
        { type: 'ssh', id: 'p2', name: 'Beta', path: '/b', connectionId: 'conn-1' },
      ],
    });
    expect(projects.map((p) => [p.id, p.hostRef])).toEqual([
      ['p1', 'local:local'],
      ['p2', 'remote:conn-1'],
    ]);
  });

  it('canlı ACP oturumu + agentStatus fallback ile aktif işleri izin bekleyenler üstte sıralar', () => {
    const conversations = mapConversations([
      {
        id: 'c-db-working',
        taskId: 't1',
        projectId: 'p1',
        title: 'Mac üzerinde çalışan iş',
        providerId: 'antigravity',
        type: 'acp',
        agentStatus: 'working',
        lastInteractedAt: '2026-11-20T12:00:00Z',
      },
      {
        id: 'c-live-perm',
        taskId: 't2',
        projectId: 'p1',
        title: 'Onay bekleyen iş',
        providerId: 'codex',
        type: 'acp',
        agentStatus: 'idle',
        lastInteractedAt: '2026-11-20T11:00:00Z',
      },
      {
        id: 'c-done',
        taskId: 't3',
        projectId: 'p1',
        title: 'Biten iş',
        providerId: 'kimi',
        type: 'acp',
        agentStatus: 'working',
        lastInteractedAt: '2026-11-20T10:00:00Z',
      },
    ]);

    const active = buildActiveWorkList(conversations, {
      'c-live-perm': {
        conversationId: 'c-live-perm',
        providerId: 'codex',
        lifecycle: 'working',
        isGenerating: true,
        pendingPermissionCount: 1,
        backgroundAgentCount: 0,
        queuedPromptCount: 0,
        title: 'Onay bekleyen iş',
        updatedAt: 2000,
      },
      // Canlı oturum hazır/bitmiş raporluyorsa eski DB agentStatus='working' yüzünden takılı kalmaz
      'c-done': {
        conversationId: 'c-done',
        providerId: 'kimi',
        lifecycle: 'ready',
        isGenerating: false,
        pendingPermissionCount: 0,
        backgroundAgentCount: 0,
        queuedPromptCount: 0,
        title: 'Biten iş',
        updatedAt: 1000,
      },
    });

    expect(active.map((a) => a.conversationId)).toEqual(['c-live-perm', 'c-db-working']);
    expect(active[0]?.awaitingInput).toBe(true);
    expect(active[1]?.working).toBe(true);
  });
});

describe('mapSessionConfig / mapSessionAgents / mapHandoffList / buildMobileHandoffContext', () => {
  it('oturum yapılandırmasındaki model, efor ve izin modu seçeneklerini eşler', () => {
    const config = mapSessionConfig({
      modelOptions: {
        configId: 'model',
        selected: 'gpt-5.4',
        available: [
          { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Ana model' },
          { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
        ],
      },
      efforts: {
        configId: 'effort',
        selected: 'high',
        available: [
          { id: 'low', name: 'Düşük' },
          { id: 'high', name: 'Yüksek' },
        ],
      },
      modeOptions: {
        configId: 'mode',
        selected: 'default',
        available: [
          { id: 'default', name: 'Sor' },
          { id: 'full-access', name: 'Tam yetki' },
        ],
      },
    });
    expect(config.currentModel).toBe('gpt-5.4');
    expect(config.modelLabel).toBe('GPT-5.4');
    expect(config.currentEffort).toBe('high');
    expect(config.effortLabel).toBe('Yüksek');
    expect(config.currentModeId).toBe('default');
    expect(config.modeLabel).toBe('Sor');
    expect(config.modelOptions).toHaveLength(2);
    expect(config.efforts.map((e) => e.id)).toEqual(['low', 'high']);
    expect(config.modeOptions.map((m) => m.id)).toEqual(['default', 'full-access']);
  });

  it('alt ajanları sıralar ve etkinlik adımlarını korur', () => {
    const agents = mapSessionAgents([
      {
        agentId: 'done-1',
        toolCallId: 'tc-1',
        name: 'Kod inceleyici',
        status: 'completed',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'medium',
        prompt: 'PR diff incele',
        summary: 'Sorun bulunmadı.',
        startedAt: 2000,
        completedAt: 5000,
        activities: [
          {
            id: 'a1',
            kind: 'tool',
            title: 'git diff',
            detail: '3 dosya',
            status: 'done',
            timestamp: 3000,
          },
        ],
      },
      {
        agentId: '3b241101-e2bb-4255-8caf-4136c566a962',
        toolCallId: 'tc-2',
        name: 'Araştırmacı',
        status: 'running',
        provider: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        prompt: 'API şemasını bul',
        startedAt: 1000,
        activities: [
          {
            id: 'a2',
            kind: 'thinking',
            title: 'Dosyalar taranıyor',
            status: 'running',
            timestamp: 1500,
          },
          { id: 'bad' },
        ],
      },
      'bozuk',
      {},
    ]);

    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      agentId: '3b241101-e2bb-4255-8caf-4136c566a962',
      name: 'Araştırmacı',
      status: 'running',
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      prompt: 'API şemasını bul',
      summary: null,
      completedAt: null,
    });
    expect(agents[0]?.activities).toEqual([
      {
        id: 'a2',
        kind: 'thinking',
        title: 'Dosyalar taranıyor',
        detail: null,
        status: 'running',
        timestamp: 1500,
      },
    ]);
    expect(agents[1]?.summary).toBe('Sorun bulunmadı.');
  });

  it('devir kayıtlarını ve superseded haritasını güvenli eşler', () => {
    const raw = {
      records: [
        [
          'c2',
          {
            version: 1,
            mode: 'handoff',
            sourceConversationId: 'c1',
            sourceTitle: 'İlk sohbet',
            context: 'Özet metni',
            contextDelivered: false,
            createdAt: 12345,
            targetEffort: 'high',
            chain: [
              {
                conversationId: 'c1',
                fromProviderId: 'claude',
                fromModelLabel: 'Sonnet',
                toProviderId: 'codex',
                toModelLabel: 'GPT',
                createdAt: 12340,
              },
            ],
          },
        ],
        [
          'bad-version',
          {
            version: 2,
            mode: 'fork',
            sourceConversationId: 'c1',
            sourceTitle: 'x',
            context: '',
            createdAt: 1,
          },
        ],
        [
          'c-empty-source',
          {
            version: 1,
            mode: 'fork',
            sourceConversationId: '',
            sourceTitle: 'x',
            context: '',
            createdAt: 1,
          },
        ],
      ],
      superseded: [
        ['c1', 'c2'],
        ['c2', 'c3'],
        ['same', 'same'],
      ],
    };

    const handoffs = mapHandoffList(raw);
    const superseded = mapHandoffSuperseded(raw);

    expect(Object.keys(handoffs)).toEqual(['c2']);
    expect(handoffs['c2']).toMatchObject({
      conversationId: 'c2',
      mode: 'handoff',
      sourceConversationId: 'c1',
      sourceTitle: 'İlk sohbet',
      context: 'Özet metni',
      contextDelivered: false,
      targetEffort: 'high',
      supersededBy: 'c3',
    });
    expect(handoffs['c2']?.chain).toHaveLength(1);
    expect(superseded).toEqual({ c1: 'c2', c2: 'c3' });
  });

  it('mobil devir özetini bütçeye sığdırır ve mesaj yoksa boş döner', () => {
    expect(
      buildMobileHandoffContext(
        [{ kind: 'thinking', id: 'th1', text: 'iç düşünce', active: false }],
        'Deneme'
      )
    ).toBe('');

    const summary = buildMobileHandoffContext(
      [
        { kind: 'message', id: '1', role: 'user', text: 'Eski mesaj ' + 'a'.repeat(500) },
        { kind: 'tool', id: 't1', title: 'Komut', status: 'done', detail: 'ls', children: [] },
        { kind: 'message', id: '2', role: 'assistant', text: 'Güncel yanıt özeti' },
      ],
      'Mobil Parite',
      { sourceProviderLabel: 'Claude Code', budget: 650 }
    );
    expect(summary.length).toBeLessThanOrEqual(650);
    expect(summary).toContain('Mobil Parite');
    expect(summary).toContain('Claude Code');
    expect(summary).toContain('Güncel yanıt özeti');
  });
});
