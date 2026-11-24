import type { Secret } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import {
  base64UrlDecode,
  connectRemoteTransport,
  createMemorySocketPair,
  REMOTE_CLOSE,
  REMOTE_NOTIFICATIONS_CHANNEL,
  type RemoteClientTransport,
} from '@orkestra/wire/remote';
import type { RemoteListener, RemoteServer } from '@orkestra/wire/remote/node';
import {
  connect,
  createController,
  defineContract,
  procedure,
  type Controller,
} from '@orkestra/wire/rpc';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentActivityEventSchema,
  agentActivitySnapshotSchema,
  type AgentActivityEvent,
} from '@core/features/agent-activity/api/contract';
import { AgentActivityFeed } from '@core/features/agent-activity/node/agent-activity-feed';
import { createAgentActivityWireController } from '@core/features/agent-activity/node/wire-controller';
import { parsePairingPayload } from '@core/features/remote-access/api/pairing-payload';
import {
  RemoteAccessService,
  type StoredRemoteAccessState,
} from '@core/features/remote-access/node/remote-access-service';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

// Uçtan uca (servis düzeyi): gerçek uzak erişim servisi + gerçek ajan etkinliği akışı + gerçek
// şifreli el sıkışma (bellek içi soket). Telefonun arka plan servisinin konuştuğu kanalın
// snapshot/canlı olay/ayar/iptal davranışını sınar.

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, Secret<string>>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: Secret<string>) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

const conversationsContract = defineContract({
  getConversations: procedure({ input: z.void(), output: z.array(z.string()) }),
});

async function setup() {
  let persisted: StoredRemoteAccessState | null = null;
  let captured: RemoteServer | undefined;
  const clock = { now: 7_000_000 };
  const feed = new AgentActivityFeed({
    resolveContext: async ({ conversationId }) => ({
      projectId: 'p1',
      taskId: 't1',
      title: `Chat ${conversationId}`,
      projectName: 'Orkestra',
      providerName: 'Claude',
    }),
    hostName: () => 'Ornek-Mac',
    now: () => clock.now,
    pruneIntervalMs: 0,
  });
  const service = new RemoteAccessService({
    persistence: {
      load: async () => (persisted ? structuredClone(persisted) : null),
      save: async (state) => {
        persisted = structuredClone(state);
      },
    },
    secrets: new MemorySecrets(),
    logger: noopLogger,
    hostName: () => 'Ornek-Mac',
    networkInterfaces: () => ({
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    }),
    isSecureStorageAvailable: () => true,
    listen: async (server, options) => {
      captured = server;
      const listener: RemoteListener = { port: options.port || 50999, close: async () => {} };
      return listener;
    },
    now: () => clock.now,
    pickPort: () => 50123,
  });
  service.attachAgentActivity({
    controller: createAgentActivityWireController(feed),
    setPublishing: (enabled) => feed.setPublishing(enabled),
    dispose: () => feed.dispose(),
  });
  const controllers: Record<string, Controller> = {
    conversations: createController(conversationsContract, { getConversations: () => ['c1'] }),
  };
  await service.start(controllers);
  const enabled = await service.setEnabled(true);
  if (!enabled.success) throw new Error(enabled.error.message);
  const pairing = await service.createPairing();
  if (!pairing.success) throw new Error(pairing.error.message);
  const payload = parsePairingPayload(pairing.data.payload)!;

  const dial = (channel?: string): Promise<RemoteClientTransport> => {
    const pair = createMemorySocketPair();
    captured!.handleConnection(pair.server, '10.0.0.2');
    return connectRemoteTransport({
      url: 'ws://memory',
      deviceId: payload.d,
      secret: base64UrlDecode(payload.s)!,
      clientName: 'Pixel 9',
      platform: 'android',
      createSocket: () => pair.client,
      pingIntervalMs: 0,
      idleTimeoutMs: 0,
      ...(channel ? { channel } : {}),
    });
  };
  return { service, feed, clock, dial, deviceId: payload.d, persisted: () => persisted };
}

/** Canlı konuya abone olur (telefondaki yerel istemci aynı `attach` + `update` mesajlarını işler). */
async function attachEvents(connection: ReturnType<typeof connect>): Promise<AgentActivityEvent[]> {
  const events: AgentActivityEvent[] = [];
  await connection.attach('agentActivity.events', (update) => {
    events.push(agentActivityEventSchema.parse((update.delta as { event: unknown }).event));
  });
  return events;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('agent activity over the remote notifications channel', () => {
  it('delivers snapshot + live updates to the background channel while the main session stays up', async () => {
    const ctx = await setup();
    const main = await ctx.dial();
    let mainClosed = false;
    main.onClosed(() => (mainClosed = true));

    const background = await ctx.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    expect(background.welcome.channel).toBe(REMOTE_NOTIFICATIONS_CHANNEL);
    const connection = connect(background);
    const events = await attachEvents(connection);

    await ctx.feed.handleAgentEvent({
      type: 'start',
      conversationId: 'c1',
      timestamp: ctx.clock.now,
      payload: {},
    });
    ctx.clock.now += 30_000;
    await ctx.feed.handleAgentEvent({
      type: 'notification',
      conversationId: 'c1',
      timestamp: ctx.clock.now,
      payload: { notificationType: 'permission_prompt', message: 'Allow git push?' },
    });
    await waitFor(() => events.length === 2);
    expect(events[1]).toMatchObject({
      type: 'upsert',
      alert: true,
      entry: { conversationId: 'c1', state: 'needs-approval', preview: 'Allow git push?' },
    });

    const snapshot = agentActivitySnapshotSchema.parse(
      await connection.call('agentActivity.getSnapshot', undefined)
    );
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ conversationId: 'c1', state: 'needs-approval', title: 'Chat c1' }),
    ]);

    // Dar yüzey: arka plan kanalı sohbet listesini/prompt'u çağıramaz; ana oturum düşmedi.
    await expect(
      connection.call('conversations.getConversations', undefined)
    ).rejects.toMatchObject({
      code: 'UNKNOWN_PROCEDURE',
    });
    expect(mainClosed).toBe(false);
    const mainConnection = connect(main);
    await expect(mainConnection.call('conversations.getConversations', undefined)).resolves.toEqual(
      ['c1']
    );
    // Ana oturum da (uygulama açıkken) aynı akışı okuyabilir.
    await expect(
      mainConnection.call('agentActivity.getSnapshot', undefined)
    ).resolves.toMatchObject({
      publishing: true,
    });

    const state = await ctx.service.getState();
    expect(state.devices[0]).toMatchObject({ connected: true, notificationsConnected: true });
    expect(state).toMatchObject({ agentActivityAvailable: true, publishAgentActivity: true });
    await ctx.service.dispose();
  });

  it('honours the desktop publishing setting and persists it', async () => {
    const ctx = await setup();
    const background = await ctx.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    const connection = connect(background);
    const events = await attachEvents(connection);
    await ctx.feed.handleAgentEvent({
      type: 'start',
      conversationId: 'c1',
      timestamp: ctx.clock.now,
      payload: {},
    });

    const off = await ctx.service.setPublishAgentActivity(false);
    expect(off.success && off.data.publishAgentActivity).toBe(false);
    expect(ctx.persisted()?.publishAgentActivity).toBe(false);
    await ctx.feed.handleAgentEvent({
      type: 'stop',
      conversationId: 'c1',
      timestamp: ctx.clock.now + 60_000,
      payload: {},
    });
    await waitFor(() => events.some((event) => event.type === 'publishing'));
    expect(events.map((event) => event.type)).toEqual(['upsert', 'publishing']);
    await expect(connection.call('agentActivity.getSnapshot', undefined)).resolves.toMatchObject({
      publishing: false,
      entries: [],
    });
    await ctx.service.dispose();
  });

  it('closes the background channel immediately when the device is revoked', async () => {
    const ctx = await setup();
    await ctx.dial();
    const background = await ctx.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    const closed = new Promise<number>((resolve) =>
      background.onClosed((info) => resolve(info.code))
    );
    const revoked = await ctx.service.revokeDevice(ctx.deviceId);
    expect(revoked.success).toBe(true);
    expect(await closed).toBe(REMOTE_CLOSE.REVOKED);
    await ctx.service.dispose();
  });
});
