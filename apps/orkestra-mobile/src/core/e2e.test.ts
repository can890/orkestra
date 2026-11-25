import { base64UrlEncode, randomBytes } from '@orkestra/wire/remote';
import {
  createRemoteServer,
  listenRemoteServer,
  type RemoteListener,
  type RemoteServer,
} from '@orkestra/wire/remote/node';
import { WireError } from '@orkestra/wire/rpc';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDesktop, type FakeDesktop } from '../testing/fake-desktop';
import { createConnectionManager, type ConnectionManager } from './connection-manager';
import type { ConnectionStatus } from './connection-state';
import { openConversation, workingPlacement } from './conversation-session';
import { mapAccounts, mapProjects, mapTasks, mapUsage } from './mappers';
import type { PairingRecord } from './pairing-store';
import { createRemoteApi, LOCAL_HOST, REMOTE_TOPICS, topicOf, unwrapResult } from './wire-client';

const DEVICE_ID = 'device-e2e-0001';

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Zaman aşımı: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const turn = (seq: number, items: unknown[], outcome?: unknown) => ({
  id: `turn-${seq}`,
  seq,
  initiator: 'user',
  items,
  ...(outcome ? { outcome } : {}),
});
const message = (id: string, role: 'user' | 'assistant', text: string, promptId?: string) => ({
  kind: 'message',
  id,
  seq: 1,
  role,
  text,
  ...(promptId ? { promptId } : {}),
});

describe('mobil istemci ↔ gerçek geçit (127.0.0.1)', () => {
  const secret = randomBytes(32);
  let desktop: FakeDesktop;
  let server: RemoteServer;
  let listener: RemoteListener;
  let manager: ConnectionManager | undefined;
  let knownDevice = true;
  let record: PairingRecord;

  beforeEach(async () => {
    knownDevice = true;
    desktop = createFakeDesktop();
    server = createRemoteServer({
      controller: desktop.controller,
      lookupSecret: async (id) => (knownDevice && id === DEVICE_ID ? secret : null),
      hostInfo: () => ({
        hostId: 'host-e2e',
        hostName: 'Test Mac',
        addresses: ['127.0.0.1'],
        port: listener.port,
      }),
    });
    listener = await listenRemoteServer(server, { host: '127.0.0.1', port: 0 });
    record = {
      hostId: 'host-e2e',
      hostName: 'Test Mac',
      addresses: ['127.0.0.1'],
      port: listener.port,
      deviceId: DEVICE_ID,
      secret: base64UrlEncode(secret),
      pairedAt: 1,
    };
  });

  afterEach(async () => {
    manager?.stop();
    manager = undefined;
    await listener.close();
  });

  function start(overrides: Partial<PairingRecord> = {}) {
    const statuses: ConnectionStatus[] = [];
    manager = createConnectionManager({
      record: { ...record, ...overrides },
      clientName: 'E2E Telefon',
      platform: 'android',
      backoffMs: [20, 40, 80],
      handshakeTimeoutMs: 2000,
      pingIntervalMs: 0,
      idleTimeoutMs: 0,
    });
    manager.subscribe((status) => statuses.push(status));
    return { manager, statuses };
  }

  it('el sıkışır ve projeler/görevler/hesaplar canlı konulardan okunur', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    expect(m.status()).toEqual({ kind: 'connected', hostName: 'Test Mac' });
    const api = createRemoteApi(m.connection);

    const projects = api.live<unknown>(REMOTE_TOPICS.projects, () => {});
    await projects.ready;
    expect(mapProjects(projects.current()).map((p) => p.name)).toEqual(['Alfa', 'Orkestra']);

    const tasks = api.live<unknown>(topicOf(REMOTE_TOPICS.tasks, { projectId: 'p1' }), () => {});
    await tasks.ready;
    expect(mapTasks(tasks.current(), 'p1').map((t) => t.name)).toEqual(['Mobil uygulama']);

    const accounts = api.live<unknown>(
      topicOf(REMOTE_TOPICS.authList, { host: LOCAL_HOST }),
      () => {}
    );
    await accounts.ready;
    expect(mapAccounts(accounts.current()).map((a) => [a.name, a.auth])).toEqual([
      ['Claude', 'authenticated'],
      ['Codex', 'unauthenticated'],
    ]);

    const usage = mapUsage(
      await api.call('usageLimits.get', { host: LOCAL_HOST, providerIds: ['claude'] })
    );
    expect(usage[0]?.windows[0]?.usedPercent).toBe(42);

    // Canlı güncelleme: masaüstünde proje eklenir.
    desktop.projects.update((previous) => ({
      projects: [
        ...(previous as { projects: unknown[] }).projects,
        { type: 'local', id: 'p3', name: 'Beta', path: '/b' },
      ],
    }));
    await waitFor(() => mapProjects(projects.current()).length === 3, 'canlı proje');
    projects.dispose();
    tasks.dispose();
    accounts.dispose();
  });

  it('sohbeti açar, geçmişi yükler, prompt gönderir, canlı tur ve izin isteğini işler', async () => {
    desktop.history = [
      turn(1, [message('m1', 'user', 'Merhaba'), message('m2', 'assistant', 'Selam!')]),
      turn(2, [message('m3', 'user', 'Test çalıştır'), message('m4', 'assistant', 'Çalıştırdım')]),
    ];
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);

    const conversations = unwrapResult(
      await api.call('conversations.getConversationsForTask', { projectId: 'p1', taskId: 't1' })
    );
    expect((conversations as unknown[]).length).toBe(2);

    const handle = openConversation(api, 'c1');
    await waitFor(() => handle.getState().phase === 'ready', 'sohbet hazır');
    expect(handle.getState().entries.map((e) => (e.kind === 'message' ? e.text : e.kind))).toEqual([
      'Merhaba',
      'Selam!',
      'Test çalıştır',
      'Çalıştırdım',
    ]);
    expect(desktop.calls.map((c) => c.path)).toContain('conversations.acp.attach');

    // Prompt gönder: masaüstü çağrıyı uuid ve yalnızca {text} ile alır (ek/gizli bağlam yok).
    expect(await handle.send('  Merhaba telefon  ')).toBe(true);
    const sent = desktop.calls.find((c) => c.path === 'conversations.acp.sendPrompt');
    const sentInput = sent?.input as {
      promptId: string;
      prompt: Record<string, unknown>;
      conversationId: string;
    };
    expect(sentInput.conversationId).toBe('c1');
    expect(sentInput.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentInput.prompt).toEqual({ text: 'Merhaba telefon' });
    expect(handle.getState().pending).toHaveLength(1);

    // Masaüstü etkin turu yayınlar: bekleyen balon dökümdeki gerçek mesajla yer değiştirir.
    desktop.session('c1').update((previous) => ({
      ...previous,
      lifecycle: 'working',
      isGenerating: true,
      canCancel: true,
      transcript: {
        generation: 'gen-1',
        historyRevision: 0,
        lastCommittedTurnSeq: 2,
        activeTurn: turn(3, [
          message('m5', 'user', 'Merhaba telefon', sentInput.promptId),
          message('m6', 'assistant', 'Yazıyorum…'),
        ]),
      },
      pendingPermissions: [
        {
          requestId: 'req-1',
          toolCall: { title: 'Komut çalıştır', command: 'rm -rf build' },
          options: [
            { optionId: 'allow', name: 'İzin ver', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reddet', kind: 'reject_once' },
          ],
        },
      ],
    }));
    await waitFor(() => handle.getState().entries.length === 6, 'canlı tur');
    expect(handle.getState().pending).toHaveLength(0);
    expect(handle.getState().session?.isGenerating).toBe(true);
    expect(handle.getState().session?.permissions[0]?.detail).toBe('rm -rf build');

    await handle.resolvePermission('req-1', 'allow');
    expect(
      desktop.calls.find((c) => c.path === 'conversations.acp.resolvePermission')?.input
    ).toEqual({
      conversationId: 'c1',
      requestId: 'req-1',
      optionId: 'allow',
    });

    await handle.cancel();
    expect(desktop.calls.some((c) => c.path === 'conversations.acp.cancelTurn')).toBe(true);

    // Tur kesinleşir: geçmiş sürümü gösterilir (yinelenmez).
    desktop.history = [
      ...desktop.history,
      turn(3, [
        message('m5', 'user', 'Merhaba telefon', sentInput.promptId),
        message('m6', 'assistant', 'Bitti'),
      ]),
    ];
    desktop.historyRevision = 1;
    desktop.session('c1').update((previous) => ({
      ...previous,
      lifecycle: 'ready',
      isGenerating: false,
      historyRevision: 1,
      transcript: {
        generation: 'gen-1',
        historyRevision: 1,
        lastCommittedTurnSeq: 3,
        activeTurn: null,
      },
      pendingPermissions: [],
    }));
    await waitFor(
      () => handle.getState().entries.some((e) => e.kind === 'message' && e.text === 'Bitti'),
      'geçmiş tazelemesi'
    );
    expect(handle.getState().entries).toHaveLength(6);
    handle.dispose();
  });

  it('gönderim hatasında bekleyen prompt "failed" olur ve yeniden denenebilir', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);
    const handle = openConversation(api, 'c1');
    await waitFor(() => handle.getState().phase === 'ready', 'sohbet hazır');

    const original = desktop.controller.call.bind(desktop.controller);
    let fail = true;
    desktop.controller.call = async (path, input, meta) => {
      if (fail && path === 'conversations.acp.sendPrompt') {
        return { success: false, error: { type: 'session-closed', message: 'oturum kapalı' } };
      }
      return original(path, input, meta);
    };
    expect(await handle.send('selam')).toBe(false);
    const failed = handle.getState().pending[0];
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toContain('oturum kapalı');

    fail = false;
    expect(await handle.retry(failed!.promptId)).toBe(true);
    expect(handle.getState().pending[0]?.state).toBe('sending');
    handle.dispose();
  });

  it('çalışan tura canlı yönlendirme (steer) gönderir; eski masaüstü reddederse auto ile yeniden dener', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);
    const handle = openConversation(api, 'c1');
    await waitFor(() => handle.getState().phase === 'ready', 'sohbet hazır');

    expect(await handle.send('yön değiştir', 'steer')).toBe(true);
    const steered = desktop.calls.filter((c) => c.path === 'conversations.acp.sendPrompt');
    expect(steered.at(-1)?.input).toMatchObject({ placement: 'steer' });

    // Eski masaüstü: uzak yüzey koruması `steer`i bilmez → CONTRACT_MISMATCH.
    const original = desktop.controller.call.bind(desktop.controller);
    desktop.controller.call = async (path, input, meta) => {
      if (
        path === 'conversations.acp.sendPrompt' &&
        (input as { placement?: string }).placement === 'steer'
      ) {
        throw new WireError('CONTRACT_MISMATCH', 'invalid input for remote access');
      }
      return original(path, input, meta);
    };
    expect(await handle.send('ikinci yön', 'steer')).toBe(true);
    const sent = desktop.calls.filter((c) => c.path === 'conversations.acp.sendPrompt');
    expect(sent.at(-1)?.input).toMatchObject({ placement: 'auto', prompt: { text: 'ikinci yön' } });
    handle.dispose();
  });

  it.each([
    ['Claude Code / Codex (araya mesaj alır)', true, 'steer'],
    ['Antigravity, Grok, Kimi, özel ACP (araya mesaj alamaz)', false, 'queue'],
  ] as const)(
    'çalışan tura yazınca %s: onay sormaz, turu durdurmaz',
    async (_label, supportsSteering, expected) => {
      const { manager: m } = start();
      await waitFor(() => m.status().kind === 'connected', 'bağlantı');
      const api = createRemoteApi(m.connection);
      const handle = openConversation(api, 'c1');
      await waitFor(() => handle.getState().phase === 'ready', 'sohbet hazır');
      desktop.session('c1').update((previous) => ({
        ...previous,
        lifecycle: 'working',
        isGenerating: true,
        canCancel: true,
        ...(supportsSteering ? { supportsSteering: true } : {}),
      }));
      await waitFor(() => handle.getState().session?.isGenerating === true, 'çalışıyor');

      const placement = workingPlacement(handle.getState().session);
      expect(placement).toBe(expected);
      expect(await handle.send('araya mesaj', placement)).toBe(true);
      const sent = desktop.calls.filter((c) => c.path === 'conversations.acp.sendPrompt');
      expect(sent.at(-1)?.input).toMatchObject({ placement: expected });
      expect(desktop.calls.some((c) => c.path === 'conversations.acp.cancelTurn')).toBe(false);
      handle.dispose();
    }
  );

  it('bağlantı yokken yazılan mesaj telefonda bekler, bağlanınca kendiliğinden gönderilir', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);
    const original = desktop.controller.call.bind(desktop.controller);
    let attachFails = true;
    desktop.controller.call = async (path, input, meta) => {
      if (attachFails && path === 'conversations.acp.attach') throw new Error('masaüstü meşgul');
      return original(path, input, meta);
    };
    const handle = openConversation(api, 'c1');
    await waitFor(() => handle.getState().syncing === false, 'ilk deneme bitti');

    expect(await handle.send('kaybolmasın')).toBe(true);
    expect(handle.getState().pending[0]).toMatchObject({ state: 'waiting', text: 'kaybolmasın' });
    expect(desktop.calls.some((c) => c.path === 'conversations.acp.sendPrompt')).toBe(false);

    attachFails = false;
    await waitFor(
      () => desktop.calls.some((c) => c.path === 'conversations.acp.sendPrompt'),
      'bağlanınca gönderildi',
      8000
    );
    const sent = desktop.calls.find((c) => c.path === 'conversations.acp.sendPrompt');
    expect(sent?.input).toMatchObject({ prompt: { text: 'kaybolmasın' } });
    handle.dispose();
  });

  it('sıradaki mesaj silinebilir; "Şimdi gönder" turu yalnızca açık istekle durdurur', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);
    const handle = openConversation(api, 'c1');
    await waitFor(() => handle.getState().phase === 'ready', 'sohbet hazır');
    expect(await handle.send('sıraya', 'queue')).toBe(true);
    const queued = handle.getState().pending[0];
    expect(queued?.state).toBe('queued');
    desktop.session('c1').update((previous) => ({
      ...previous,
      lifecycle: 'working',
      isGenerating: true,
      queuedPrompts: [{ id: 'other' }, { id: queued!.promptId }],
    }));
    await waitFor(() => handle.getState().session?.queuedIds.length === 2, 'sıra görünür');
    expect(desktop.calls.some((c) => c.path === 'conversations.acp.cancelTurn')).toBe(false);

    await handle.sendQueuedNow(queued!.promptId);
    expect(handle.getState().actionError).toBeNull();
    const reorder = desktop.calls.find(
      (c) => c.path === 'conversations.acp.changeQueuePromptOrder'
    );
    expect(reorder?.input).toMatchObject({ ids: [queued!.promptId, 'other'] });
    expect(desktop.calls.filter((c) => c.path === 'conversations.acp.cancelTurn')).toHaveLength(1);

    expect(await handle.removeQueued(queued!.promptId)).toBe(true);
    expect(desktop.calls.at(-1)).toMatchObject({
      path: 'conversations.acp.deleteQueuedPrompt',
      input: { conversationId: 'c1', id: queued!.promptId },
    });
    expect(handle.getState().pending).toHaveLength(0);
    handle.dispose();
  });

  it('bağlantı koparsa otomatik yeniden bağlanır ve canlı konular tazelenir', async () => {
    const { manager: m, statuses } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    const api = createRemoteApi(m.connection);
    const projects = api.live<unknown>(REMOTE_TOPICS.projects, () => {});
    await projects.ready;

    expect(server.closeDevice(DEVICE_ID, 1001, 'bakım')).toBe(1);
    await waitFor(() => statuses.some((s) => s.kind === 'reconnecting'), 'kopma');
    await waitFor(() => m.status().kind === 'connected', 'yeniden bağlanma');

    // Kopukken yapılan değişiklik yeniden bağlanınca görünür.
    desktop.projects.update(() => ({
      projects: [{ type: 'local', id: 'x', name: 'Yeni', path: '/y' }],
    }));
    await waitFor(
      () =>
        mapProjects(projects.current())
          .map((p) => p.name)
          .join() === 'Yeni',
      'tazeleme'
    );
    projects.dispose();
  });

  it('cihaz iptal edilince yeniden denemeyi bırakır (auth)', async () => {
    const { manager: m } = start();
    await waitFor(() => m.status().kind === 'connected', 'bağlantı');
    knownDevice = false;
    server.closeDevice(DEVICE_ID, 4403, 'revoked');
    await waitFor(() => m.status().kind === 'failed', 'iptal');
    expect(m.status()).toEqual({ kind: 'failed', reason: 'auth' });
  });

  it('yanlış sırla bağlanılamaz ve kalıcı auth hatası verir', async () => {
    const { manager: m } = start({ secret: base64UrlEncode(randomBytes(32)) });
    await waitFor(() => m.status().kind === 'failed', 'auth hatası');
    expect(m.status()).toEqual({ kind: 'failed', reason: 'auth' });
  });

  it('ilk adres ulaşılamazsa sıradaki adrese geçer', async () => {
    const { manager: m } = start({ addresses: ['127.0.0.2', '127.0.0.1'] });
    // 127.0.0.2 de loopback'tir ama dinleyici yalnızca 127.0.0.1'de: ilk deneme reddedilir.
    await waitFor(() => m.status().kind === 'connected', 'yedek adres');
  });
});
