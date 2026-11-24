import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connect } from '../api/connect';
import { defineContract, procedure } from '../api/define';
import { WireError } from '../api/protocol';
import { createController } from '../rpc/controller';
import { connectRemoteTransport, RemoteHandshakeError } from './client';
import { createMemorySocketPair } from './memory-socket';
import { createRemoteServer, type RemoteSessionInfo } from './node/server';
import { REMOTE_CLOSE, REMOTE_NOTIFICATIONS_CHANNEL } from './protocol';

// Yardımcı oturum kanalı: aynı cihazın arka plan bildirim servisi, ana oturumu düşürmeden
// yalnızca dar bir yüzeye bağlanabilmeli.

const DEVICE_ID = 'device-0001-abcdef';
const SECRET = new Uint8Array(32).fill(7);

const mainContract = defineContract({
  echo: procedure({ input: z.object({ text: z.string() }), output: z.string() }),
});
const channelContract = defineContract({
  ping: procedure({ input: z.void(), output: z.string() }),
});

function harness(options: { withChannel?: boolean } = {}) {
  const opened: RemoteSessionInfo[] = [];
  const closed: RemoteSessionInfo[] = [];
  const server = createRemoteServer({
    controller: createController(mainContract, { echo: ({ text }) => `echo:${text}` }),
    ...(options.withChannel === false
      ? {}
      : {
          channelControllers: {
            [REMOTE_NOTIFICATIONS_CHANNEL]: createController(channelContract, {
              ping: () => 'pong',
            }),
          },
        }),
    lookupSecret: async (id) => (id === DEVICE_ID ? SECRET : null),
    hostInfo: () => ({ hostId: 'host-1', hostName: 'Mac', addresses: ['10.0.0.2'], port: 4000 }),
    onSessionOpen: (info) => opened.push(info),
    onSessionClose: (info) => closed.push(info),
  });
  const dial = (channel?: string) => {
    const pair = createMemorySocketPair();
    server.handleConnection(pair.server, '10.0.0.9');
    return connectRemoteTransport({
      url: 'ws://memory/orkestra-remote/v1',
      deviceId: DEVICE_ID,
      secret: SECRET,
      platform: 'android',
      createSocket: () => pair.client,
      handshakeTimeoutMs: 2000,
      pingIntervalMs: 0,
      idleTimeoutMs: 0,
      ...(channel ? { channel } : {}),
    });
  };
  return { server, opened, closed, dial };
}

describe('remote auxiliary channels', () => {
  it('opens a notifications session next to the main session without replacing it', async () => {
    const h = harness();
    const main = await h.dial();
    let mainClosed = false;
    main.onClosed(() => (mainClosed = true));
    const background = await h.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    expect(background.welcome.channel).toBe(REMOTE_NOTIFICATIONS_CHANNEL);
    expect(main.welcome.channel).toBeUndefined();

    const mainConnection = connect(main);
    const backgroundConnection = connect(background);
    await expect(mainConnection.call('echo', { text: 'hi' })).resolves.toBe('echo:hi');
    await expect(backgroundConnection.call('ping', undefined)).resolves.toBe('pong');
    // Kanal oturumu yalnızca kendi denetleyicisini görür.
    await expect(backgroundConnection.call('echo', { text: 'x' })).rejects.toBeInstanceOf(
      WireError
    );
    expect(mainClosed).toBe(false);
    expect(h.server.connectedDeviceIds()).toEqual([DEVICE_ID]);
    expect(h.opened.map((info) => info.channel)).toEqual([undefined, REMOTE_NOTIFICATIONS_CHANNEL]);
    h.server.closeAll();
  });

  it('replaces only the older session of the same channel', async () => {
    const h = harness();
    const main = await h.dial();
    let mainClosed = false;
    main.onClosed(() => (mainClosed = true));
    const first = await h.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    const firstClosed = new Promise<{ code: number }>((resolve) => first.onClosed(resolve));
    await h.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    expect((await firstClosed).code).toBe(REMOTE_CLOSE.REPLACED);
    expect(mainClosed).toBe(false);
    h.server.closeAll();
  });

  it('closes every session of a revoked device, including channel sessions', async () => {
    const h = harness();
    const main = await h.dial();
    const background = await h.dial(REMOTE_NOTIFICATIONS_CHANNEL);
    const codes = Promise.all([
      new Promise<number>((resolve) => main.onClosed((info) => resolve(info.code))),
      new Promise<number>((resolve) => background.onClosed((info) => resolve(info.code))),
    ]);
    expect(h.server.closeDevice(DEVICE_ID)).toBe(2);
    expect(await codes).toEqual([REMOTE_CLOSE.REVOKED, REMOTE_CLOSE.REVOKED]);
  });

  it('rejects a channel the server does not offer', async () => {
    const h = harness({ withChannel: false });
    await expect(h.dial(REMOTE_NOTIFICATIONS_CHANNEL)).rejects.toBeInstanceOf(RemoteHandshakeError);
    expect(h.opened).toEqual([]);
  });
});
