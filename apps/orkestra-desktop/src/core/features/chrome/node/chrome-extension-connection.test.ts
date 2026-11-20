import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_WAIT_MS,
  CONNECT_ERROR,
  RETRY_DELAYS_MS,
  TOKEN_ERROR,
  createConnectionManager,
  type ConnectionSettings,
  type ConnectionSocket,
} from '../../../../../../chrome-extension/lib/connection.js';

// Uzantının bağlantı yöneticisi (apps/chrome-extension/lib/connection.js): service worker aynı anda
// birkaç yerden bağlanmayı denese bile tek soket açılmalı.

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class FakeSocket implements ConnectionSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(readonly url: string) {}

  close(): void {
    this.closeCalls += 1;
    this.readyState = CLOSING;
  }

  /** Masaüstü el sıkışmayı kabul etti. */
  accept(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Soket kapandı (reddedildi, koptu ya da kapatma tamamlandı). */
  finishClose(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  /** Masaüstü el sıkışmayı reddetti. */
  reject(): void {
    this.onerror?.();
    this.finishClose();
  }
}

function setup(initial: Partial<ConnectionSettings> = {}) {
  const sockets: FakeSocket[] = [];
  const messages: unknown[] = [];
  const settings: ConnectionSettings = {
    enabled: true,
    connection: { url: 'ws://127.0.0.1:47653/', protocols: ['orkestra-chrome.v1', 'token.a'] },
    ...initial,
  };
  const manager = createConnectionManager({
    readSettings: async () => ({ ...settings }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onMessage: (_socket, data) => messages.push(data),
  });
  const live = () =>
    sockets.filter((socket) => socket.readyState === OPEN || socket.readyState === CONNECTING);
  return { manager, sockets, messages, settings, live };
}

/** Bekleyen mikro görevleri (ayar okuma, zincirlenen söz) işletir. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createConnectionManager', () => {
  it('opens a single socket when several callers connect at once', async () => {
    const { manager, sockets } = setup();
    // Service worker uyanınca: en üst düzey çağrı, alarm ve onStartup aynı anda.
    await Promise.all([manager.connect(), manager.connect(), manager.connect()]);
    expect(sockets).toHaveLength(1);
    expect(manager.status().state).toBe('connecting');

    sockets[0]!.accept();
    expect(manager.status()).toEqual({ state: 'connected', lastError: '' });

    await manager.connect();
    expect(sockets).toHaveLength(1);
  });

  it('waits for the old socket to close before opening the next one', async () => {
    const { manager, sockets } = setup();
    await manager.connect();
    sockets[0]!.accept();

    manager.disconnect();
    const reconnect = manager.connect();
    await settle();
    expect(sockets[0]!.closeCalls).toBe(1);
    expect(sockets).toHaveLength(1);

    sockets[0]!.finishClose();
    await reconnect;
    expect(sockets).toHaveLength(2);
    sockets[1]!.accept();
    expect(manager.status().state).toBe('connected');
  });

  it('does not wait forever for a socket that never reports closing', async () => {
    const { manager, sockets } = setup();
    await manager.connect();
    sockets[0]!.accept();

    manager.disconnect();
    const reconnect = manager.connect();
    await vi.advanceTimersByTimeAsync(CLOSE_WAIT_MS);
    await reconnect;
    expect(sockets).toHaveLength(2);
  });

  it('ends with one live socket after the options page saves and reloads', async () => {
    const { manager, sockets, live } = setup();
    // Ayarlar sayfası: storage.onChanged → disconnect + connect, hemen ardından 'reload' iletisi.
    manager.disconnect();
    void manager.connect();
    manager.disconnect();
    const last = manager.connect();
    await settle();
    for (const socket of sockets) if (socket.readyState === CLOSING) socket.finishClose();
    await last;
    await settle();

    expect(live()).toHaveLength(1);
    live()[0]!.accept();
    expect(manager.status().state).toBe('connected');
  });

  it('uses the settings saved while a connection attempt was already running', async () => {
    const { manager, sockets, settings } = setup();
    const first = manager.connect();
    settings.connection = { url: 'ws://127.0.0.1:50000/', protocols: ['orkestra-chrome.v1'] };
    manager.disconnect();
    await Promise.all([first, manager.connect()]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://127.0.0.1:50000/');
  });

  it('retries continuously with graduated backoff after a refused connection', async () => {
    const { manager, sockets } = setup();
    await manager.connect();
    sockets[0]!.reject();
    expect(manager.status()).toEqual({ state: 'disconnected', lastError: CONNECT_ERROR });

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(2);
    sockets[1]!.reject();

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]!);
    expect(sockets).toHaveLength(3);
    sockets[2]!.reject();

    // 3. deneme ve sonrasında RETRY_DELAYS_MS son değeri (5000ms) ile sürekli yeniden dener.
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[2]!);
    expect(sockets).toHaveLength(4);
    sockets[3]!.accept();
    expect(manager.status()).toEqual({ state: 'connected', lastError: '' });

    // Bağlantı koptuğunda hızlı deneme sayacı sıfırlanmış olarak tekrar 1000ms ile başlar.
    sockets[3]!.finishClose();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(sockets).toHaveLength(5);
  });

  it('does not reconnect after the user disconnects', async () => {
    const { manager, sockets, settings } = setup();
    await manager.connect();
    sockets[0]!.accept();

    settings.enabled = false;
    manager.disconnect();
    sockets[0]!.finishClose();
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.connect();

    expect(sockets).toHaveLength(1);
    expect(manager.status()).toEqual({ state: 'disconnected', lastError: '' });
  });

  it('reports a missing token without opening a socket', async () => {
    const { manager, sockets } = setup({ connection: null });
    await manager.connect();
    expect(sockets).toHaveLength(0);
    expect(manager.status()).toEqual({ state: 'disconnected', lastError: TOKEN_ERROR });
  });

  it('delivers messages only from the socket it tracks', async () => {
    const { manager, sockets, messages } = setup();
    await manager.connect();
    const first = sockets[0]!;
    const deliver = first.onmessage!;
    first.accept();
    deliver({ data: 'a' });

    manager.disconnect();
    deliver({ data: 'b' });
    expect(messages).toEqual(['a']);
  });
});
