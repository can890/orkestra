import { describe, expect, it } from 'vitest';
import {
  buildActiveWorkList,
  buildMobileHandoffContext,
  describeHandoffLineage,
  formatTranscriptMarkdown,
  mapAccounts,
  mapConversations,
  mapHandoffList,
  mapHandoffSuperseded,
  mapHistoryPage,
  mapNotifications,
  mapProjects,
  mapSessionAgents,
  mapSessionConfig,
  mapSessionState,
  mapSessionUsage,
  queueReasonText,
  mapTasks,
  mapTaskStats,
  mapTurn,
  mapUsage,
} from './mappers';
import { TranscriptStore } from './transcript-store';
import { foldMobileEntries, formatCompactElapsed, formatTurnFoldDuration } from './turn-fold';

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

  it('bağlam devri (context-handoff) kaydını atlamaz ve soy satırında "yeni bağlama taşındı" der', () => {
    const raw = {
      records: [
        [
          'succ',
          {
            version: 1,
            mode: 'context-handoff',
            sourceConversationId: 'src',
            sourceTitle: 'Mutfak dolabı',
            context: '',
            contextDelivered: true,
            createdAt: 1,
            contextSource: 'agent-brief',
            transcriptPath: '/home/u/.orkestra/handoffs/succ.md',
          },
        ],
        [
          'other',
          {
            version: 1,
            mode: 'unknown-mode',
            sourceConversationId: 'src',
            context: '',
            createdAt: 1,
          },
        ],
      ],
      superseded: [],
    };
    const handoffs = mapHandoffList(raw);
    expect(Object.keys(handoffs)).toEqual(['succ']);
    expect(handoffs['succ']).toMatchObject({
      mode: 'context-handoff',
      sourceConversationId: 'src',
      contextDelivered: true,
    });
    expect(describeHandoffLineage(handoffs['succ']!)).toBe(
      '"Mutfak dolabı" sohbetinden yeni bağlama taşındı'
    );
    expect(describeHandoffLineage({ mode: 'fork', sourceTitle: 'A' })).toBe(
      '"A" sohbetinden çatallandı'
    );
    expect(describeHandoffLineage({ mode: 'handoff', sourceTitle: 'A' })).toBe(
      '"A" sohbetinden devredildi'
    );
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

describe('mapNotifications ve formatTranscriptMarkdown', () => {
  it('bildirimleri okunmamış öncelikli ve tarihe göre sıralar', () => {
    const items = mapNotifications({
      n1: {
        id: 'n1',
        kind: 'done',
        title: 'Eski okunmuş',
        body: 'Tamamlandı',
        target: { kind: 'task', projectId: 'p1', taskId: 't1', conversationId: 'c1' },
        count: 1,
        createdAt: 2000,
        readAt: 2500,
      },
      n2: {
        id: 'n2',
        kind: 'permission',
        title: 'İzin gerekiyor',
        body: 'Komut onayı',
        target: { kind: 'task', projectId: 'p1', taskId: 't2' },
        count: 2,
        createdAt: 1000,
        readAt: null,
      },
    });
    expect(items.map((i) => i.id)).toEqual(['n2', 'n1']);
    expect(items[0]?.target).toEqual({ kind: 'task', projectId: 'p1', taskId: 't2' });
    expect(items[1]?.target).toEqual({
      kind: 'task',
      projectId: 'p1',
      taskId: 't1',
      conversationId: 'c1',
    });
  });

  it('sohbet dökümünü okunabilir Markdown metnine çevirir', () => {
    const md = formatTranscriptMarkdown(
      [
        { kind: 'message', id: 'm1', role: 'user', text: 'Durum nedir?' },
        { kind: 'thinking', id: 'th1', text: 'düşünce', active: false },
        { kind: 'message', id: 'm2', role: 'assistant', text: 'Her şey hazır.' },
      ],
      'Sovra APK',
      'Claude Code'
    );
    expect(md).toContain('# Sovra APK');
    expect(md).toContain('## Kullanıcı');
    expect(md).toContain('## Claude Code');
    expect(md).toContain('Her şey hazır.');
    expect(md).not.toContain('düşünce');
  });

  it('zengin araç çıktısı, diff, mesaj zaman damgası ve ekleri eşler', () => {
    const entries = mapTurn({
      id: 't-rich',
      items: [
        {
          kind: 'message',
          id: 'u1',
          role: 'user',
          text: 'Buna bak',
          createdAt: 1700000000000,
          attachments: [{ id: 'a1', name: 'ekran.png', mimeType: 'image/png' }],
        },
        {
          kind: 'thinking',
          id: 'th1',
          text: 'analiz',
          status: 'done',
          durationMs: 4200,
        },
        {
          kind: 'modify-file-tool-call',
          id: 'ed1',
          title: 'Dosya düzenle',
          path: 'src/App.tsx',
          oldText: 'const a = 1;',
          newText: 'const a = 2;',
          status: 'done',
        },
        {
          kind: 'execute-tool-call',
          id: 'ex1',
          title: 'Komut',
          command: 'pnpm test',
          outputText: '100 passed',
          status: 'done',
        },
      ],
    });
    expect(entries[0]).toMatchObject({
      kind: 'message',
      createdAt: 1700000000000,
      attachments: [{ id: 'a1', name: 'ekran.png', mimeType: 'image/png' }],
    });
    expect(entries[1]).toMatchObject({ kind: 'thinking', durationMs: 4200 });
    expect(entries[2]).toMatchObject({
      kind: 'tool',
      diff: { oldText: 'const a = 1;', newText: 'const a = 2;' },
    });
    expect(entries[3]).toMatchObject({ kind: 'tool', output: '100 passed' });
  });

  it('upToItemId ile yalnızca seçilen mesaja kadar çatallama özeti çıkarır', () => {
    const ctx = buildMobileHandoffContext(
      [
        { kind: 'message', id: 'm1', role: 'user', text: 'Birinci soru' },
        { kind: 'message', id: 'm2', role: 'assistant', text: 'Birinci yanıt' },
        { kind: 'message', id: 'm3', role: 'user', text: 'İkinci soru' },
      ],
      'Test',
      { upToItemId: 'm2' }
    );
    expect(ctx).toContain('Birinci yanıt');
    expect(ctx).not.toContain('İkinci soru');
  });

  it('mapTaskStats çalışma alanı git istatistiklerini okur', () => {
    const stats = mapTaskStats({
      byWorkspaceId: {
        ws1: { diff: { additions: 42, deletions: 7, files: 3 }, branch: 'feat/x' },
        ws2: { additions: 0, deletions: 0, files: 0 },
      },
    });
    expect(stats['ws1']).toEqual({
      workspaceId: 'ws1',
      additions: 42,
      deletions: 7,
      files: 3,
      branch: 'feat/x',
    });
    expect(stats['ws2']).toBeUndefined();
  });
});

describe('queue reasons', () => {
  it('maps the optional reason per queued prompt and ignores missing ones', () => {
    const view = mapSessionState({
      lifecycle: 'working',
      queuedPrompts: [
        { id: 'a', text: 'x', queueReason: 'no-steering' },
        { id: 'b', text: 'y' },
        { id: '', text: 'z', queueReason: 'connecting' },
      ],
    });
    expect(view.queuedIds).toEqual(['a', 'b']);
    expect(view.queueReasons).toEqual({ a: 'no-steering' });
    expect(mapSessionState(null).queueReasons).toEqual({});
  });

  it('turns each reason into one Turkish line and unknown ones into nothing', () => {
    expect(queueReasonText('antigravity-orchestrator', 'Antigravity')).toBe(
      'Orkestratör kipinde Antigravity mesajı iş bitince alır.'
    );
    expect(queueReasonText('no-steering', 'Grok')).toBe(
      'Grok çalışırken mesaj alamıyor; iş bitince gönderilecek.'
    );
    expect(queueReasonText('no-steering', ' ')).toMatch(/^Ajan çalışırken/);
    for (const reason of [
      'antigravity-stream-json',
      'background-task',
      'awaiting-permission',
      'connecting',
    ])
      expect(queueReasonText(reason, 'X')).toMatch(/gönderilecek\.|alır\.$/);
    expect(queueReasonText('from-a-newer-host', 'X')).toBeNull();
    expect(queueReasonText(undefined, 'X')).toBeNull();
  });
});

describe('yeni ACP paritesi (elicitations, activity, plan, config, agents, usage, turn-fold)', () => {
  it('mapSessionState elicitations, activity, queuedPrompts ve oturum bayraklarını eşler', () => {
    const view = mapSessionState({
      lifecycle: 'working',
      isGenerating: true,
      agentTurnActive: true,
      backgroundAgentCount: 2,
      lastStopReason: 'end_turn',
      lastTurnErrored: true,
      activity: { turnStartedAt: 1000, lastActivityAt: 4500, backgroundTasks: 3 },
      queuedPrompts: [
        { id: 'q1', text: 'Sonraki iş', queueReason: 'no-steering' },
        { id: 'q2', text: 'İkinci iş' },
      ],
      pendingElicitations: [
        {
          requestId: 'el-1',
          elicitationId: 'e-raw',
          toolCallId: 'tc-1',
          mode: 'form',
          message: 'Devam edelim mi?',
          requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
        { requestId: '' },
      ],
    });

    expect(view.elicitations).toEqual([
      {
        requestId: 'el-1',
        elicitationId: 'e-raw',
        toolCallId: 'tc-1',
        mode: 'form',
        message: 'Devam edelim mi?',
        requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    ]);
    expect(view.activity).toEqual({
      turnStartedAt: 1000,
      lastActivityAt: 4500,
      backgroundTasks: 3,
    });
    expect(view.queuedPrompts).toEqual([
      { id: 'q1', text: 'Sonraki iş', queueReason: 'no-steering' },
      { id: 'q2', text: 'İkinci iş' },
    ]);
    expect(view.lastStopReason).toBe('end_turn');
    expect(view.lastTurnErrored).toBe(true);
    expect(view.agentTurnActive).toBe(true);
    expect(view.backgroundAgentCount).toBe(2);
  });

  it('mapSessionConfig modeLabel ve collaborationModeLabel alanlarını ayırır ve availableCommands okur', () => {
    const config = mapSessionConfig({
      modeOptions: {
        configId: 'mode',
        selected: 'full-access',
        available: [{ id: 'full-access', name: 'Tam yetki' }],
      },
      collaborationModeOptions: {
        configId: 'collaborationMode',
        selected: 'plan',
        available: [{ id: 'plan', name: 'Plan' }],
      },
      availableCommands: [
        { name: 'compact', description: 'Bağlamı özetle', inputHint: '[talimat]' },
        { name: '' },
      ],
    });
    expect(config.modeLabel).toBe('Tam yetki');
    expect(config.collaborationModeLabel).toBe('Plan');
    expect(config.availableCommands).toEqual([
      { name: 'compact', description: 'Bağlamı özetle', inputHint: '[talimat]' },
    ]);

    const onlyCollab = mapSessionConfig({
      collaborationModeOptions: {
        configId: 'collaborationMode',
        selected: 'plan',
        available: [{ id: 'plan', name: 'Plan' }],
      },
    });
    expect(onlyCollab.modeLabel).toBeNull();
    expect(onlyCollab.collaborationModeLabel).toBe('Plan');
  });

  it('mapTurn create-plan-tool-call, thinking.startedAt, subagent/execute/group alanları ve interrupted outcome eşler', () => {
    const entries = mapTurn({
      id: 't-parity',
      seq: 10,
      startedAt: 1700000000000,
      completedAt: 1700000012000,
      initiator: 'agent',
      items: [
        {
          kind: 'thinking',
          id: 'th-1',
          text: 'Düşünüyorum',
          status: 'done',
          startedAt: 1700000000500,
          durationMs: 2500,
        },
        {
          kind: 'create-plan-tool-call',
          id: 'pl-1',
          planId: 'plan-42',
          status: 'running',
          entries: [
            { id: 's1', content: 'Adım 1', status: 'completed' },
            { id: 's2', content: 'Adım 2', status: 'in_progress' },
          ],
        },
        {
          kind: 'spawn-subagent-tool-call',
          id: 'sub-1',
          title: 'Araştırmacı',
          name: 'research',
          status: 'done',
          agentId: 'ag-1',
          background: true,
          statusUnknown: true,
        },
        {
          kind: 'execute-tool-call',
          id: 'exec-1',
          title: 'Build',
          command: 'pnpm build',
          status: 'running',
          backgroundTask: true,
        },
        {
          kind: 'tool-group',
          id: 'grp-1',
          label: 'Okumalar',
          groupKind: 'read',
          status: 'done',
          children: [],
        },
      ],
      outcome: { kind: 'interrupted' },
    });

    expect(entries[0]).toMatchObject({
      kind: 'thinking',
      startedAt: 1700000000500,
      durationMs: 2500,
      turnStartedAt: 1700000000000,
      turnCompletedAt: 1700000012000,
      turnInitiator: 'agent',
    });
    expect(entries[1]).toMatchObject({
      kind: 'plan',
      id: 'pl-1',
      planId: 'plan-42',
      streaming: true,
      entries: [
        { id: 's1', content: 'Adım 1', status: 'completed' },
        { id: 's2', content: 'Adım 2', status: 'in_progress' },
      ],
    });
    expect(entries[2]).toMatchObject({
      kind: 'tool',
      agentId: 'ag-1',
      background: true,
      statusUnknown: true,
    });
    expect(entries[3]).toMatchObject({
      kind: 'tool',
      backgroundTask: { state: 'running' },
    });
    expect(entries[4]).toMatchObject({
      kind: 'tool',
      groupKind: 'read',
    });
    expect(entries[5]).toMatchObject({
      kind: 'notice',
      tone: 'info',
      text: 'Tur kesintiye uğradı.',
    });
  });

  it('mapSessionAgents interrupted/statusUnknown/detached ve mapSessionUsage cost alanlarını korur', () => {
    const agents = mapSessionAgents([
      {
        agentId: 'a1',
        toolCallId: 'tc1',
        name: 'Codex',
        status: 'failed',
        startedAt: 10,
        interrupted: true,
        statusUnknown: true,
        detached: true,
      },
    ]);
    expect(agents[0]).toMatchObject({
      interrupted: true,
      statusUnknown: true,
      detached: true,
    });

    expect(
      mapSessionUsage({
        contextSize: 200_000,
        contextUsed: 50_000,
        cost: { amount: 0.42, currency: 'USD' },
      })
    ).toEqual({
      contextSize: 200_000,
      contextUsed: 50_000,
      percent: 25,
      cost: { amount: 0.42, currency: 'USD' },
    });
    expect(mapSessionUsage({ contextSize: 100, contextUsed: 10 })?.cost).toBeNull();
  });

  it('TranscriptStore retainUntilPage ile yeni geçmiş dönene kadar eski etkin turu tutar', () => {
    const store = new TranscriptStore();
    store.applyPage(
      mapHistoryPage({
        turns: [{ id: 't1', seq: 1, items: [{ kind: 'message', id: 'm1', role: 'user', text: 'ilk' }] }],
        nextCursor: null,
        position: { generation: 'g1', historyRevision: 1 },
      }),
      true
    );
    store.setActiveTurn({
      id: 't2',
      seq: 2,
      items: [{ kind: 'message', id: 'm2', role: 'assistant', text: 'canlı cevap' }],
    });
    expect(store.entries()).toHaveLength(2);

    // activeTurn null oldu ama historyRevision arttığı için sayfa bekleniyor -> kaybolmaz
    store.setActiveTurn(null, { retainUntilPage: true });
    expect(store.entries().map((e) => (e.kind === 'message' ? e.text : ''))).toEqual([
      'ilk',
      'canlı cevap',
    ]);

    // Yeni sayfa gelince retainedActive temizlenir ve geçmiş sürümü görünür
    store.applyPage(
      mapHistoryPage({
        turns: [
          { id: 't2', seq: 2, items: [{ kind: 'message', id: 'm2', role: 'assistant', text: 'kesin cevap' }] },
        ],
        nextCursor: null,
        position: { generation: 'g1', historyRevision: 2 },
      }),
      false
    );
    expect(store.entries().map((e) => (e.kind === 'message' ? e.text : ''))).toEqual([
      'ilk',
      'kesin cevap',
    ]);
  });

  it('turn-fold süre biçimlerini, elicit-* Q&A korumasını ve aktif tur plan görünürlüğünü destekler', () => {
    expect(formatCompactElapsed(999)).toBeUndefined();
    expect(formatCompactElapsed(12_400)).toBe('12sn');
    expect(formatCompactElapsed(63_000)).toBe('1d 3sn');
    expect(formatCompactElapsed(3_840_000)).toBe('1sa 4d');
    expect(formatTurnFoldDuration(63_000)).toBe('1 dk 3 sn');

    const rows = foldMobileEntries(
      [
        {
          kind: 'message',
          id: 'u1',
          role: 'user',
          text: 'Bunu yap',
          turnStartedAt: 1_700_000_000_000,
          turnCompletedAt: 1_700_000_015_000,
        },
        {
          kind: 'tool',
          id: 'tc1',
          title: 'Dosya oku',
          status: 'done',
          detail: 'a.ts',
          children: [],
          turnStartedAt: 1_700_000_000_000,
          turnCompletedAt: 1_700_000_015_000,
        },
        {
          kind: 'message',
          id: 'elicit-1',
          role: 'user',
          text: 'Redis seçildi',
          isElicitationAnswer: true,
          turnStartedAt: 1_700_000_000_000,
          turnCompletedAt: 1_700_000_015_000,
        },
        {
          kind: 'message',
          id: 'a1',
          role: 'assistant',
          text: 'Tamamlandı.',
          turnStartedAt: 1_700_000_000_000,
          turnCompletedAt: 1_700_000_015_000,
        },
      ],
      { isWorking: false, searchActive: false, expandedFoldIds: new Set() }
    );

    // elicit-1 yeni tur açmaz, ama katlama dışında görünür kalır.
    expect(rows.map((r) => (r.kind === 'turn-fold' ? 'fold' : r.entry.id))).toEqual([
      'u1',
      'fold',
      'elicit-1',
      'a1',
    ]);
    const fold = rows[1];
    expect(fold?.kind).toBe('turn-fold');
    if (fold?.kind === 'turn-fold') {
      expect(fold.durationMs).toBe(15_000);
      expect(fold.label).toBe('15 sn çalıştı · 1 araç');
    }

    // Aktif turda plan öğesi katlanmaz.
    const activeRows = foldMobileEntries(
      [
        { kind: 'message', id: 'u2', role: 'user', text: 'Plan çıkar' },
        {
          kind: 'plan',
          id: 'p1',
          planId: 'pl',
          entries: [{ id: '1', content: 'Aşama 1', status: 'in_progress' }],
          streaming: true,
          text: 'Aşama 1',
        },
        { kind: 'message', id: 'a2', role: 'assistant', text: 'Plan hazır.' },
      ],
      { isWorking: true, searchActive: false, expandedFoldIds: new Set() }
    );
    expect(activeRows.every((r) => r.kind === 'entry')).toBe(true);
    expect(activeRows.some((r) => r.kind === 'entry' && r.entry.kind === 'plan')).toBe(true);
  });
});
