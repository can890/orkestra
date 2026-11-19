import { describe, expect, it, vi } from 'vitest';
import { AppSession } from './app-session';
import type { ConnectionManager } from './connection-manager';
import { parsePairingPayload } from './pairing';
import { createMemorySecureStore, createPairingRepository } from './pairing-store';

const SECRET = 'A'.repeat(43);
const payloadText = JSON.stringify({
  k: 'orkestra-pair',
  v: 1,
  h: 'host-1',
  n: 'Mac',
  a: ['192.168.1.5'],
  p: 4000,
  d: 'device-0001-abcdef',
  s: SECRET,
});

function fakeManager() {
  const stop = vi.fn();
  const manager = {
    connection: {} as ConnectionManager['connection'],
    status: () => ({ kind: 'connecting' as const }),
    subscribe: () => () => {},
    refresh: vi.fn(),
    stop,
  };
  return { manager, stop };
}

function setup() {
  const store = createMemorySecureStore();
  const repository = createPairingRepository(store);
  const { manager, stop } = fakeManager();
  const createManager = vi.fn(() => manager);
  const session = new AppSession({
    repository,
    clientName: 'Test',
    platform: 'android',
    now: () => 99,
    createManager,
  });
  return { session, repository, createManager, stop, manager };
}

describe('AppSession', () => {
  it('kayıt yoksa eşleştirme ekranına düşer', async () => {
    const { session, createManager } = setup();
    expect(session.getState().phase).toBe('loading');
    await session.init();
    expect(session.getState().phase).toBe('unpaired');
    expect(createManager).not.toHaveBeenCalled();
  });

  it('eşleştirmede kaydı güvenli depoya yazar ve bağlanır; yeniden açılışta kayıttan bağlanır', async () => {
    const { session, repository, createManager } = setup();
    await session.init();
    const parsed = parsePairingPayload(payloadText);
    if (!parsed.ok) throw new Error('payload');
    await session.pair(parsed.payload);
    expect(session.getState().phase).toBe('paired');
    expect(await repository.load()).toMatchObject({ deviceId: 'device-0001-abcdef', pairedAt: 99 });
    expect(createManager).toHaveBeenCalledTimes(1);

    const second = new AppSession({
      repository,
      clientName: 'Test',
      platform: 'android',
      createManager,
    });
    await second.init();
    expect(second.getState().phase).toBe('paired');
    expect(createManager).toHaveBeenCalledTimes(2);
  });

  it('eşleşmeyi kaldırınca bağlantıyı durdurur ve sırrı siler', async () => {
    const { session, repository, stop } = setup();
    const parsed = parsePairingPayload(payloadText);
    if (!parsed.ok) throw new Error('payload');
    await session.pair(parsed.payload);
    await session.unpair();
    expect(stop).toHaveBeenCalled();
    expect(await repository.load()).toBeNull();
    expect(session.getState().phase).toBe('unpaired');
  });

  it('yeniden eşleşmede önceki yöneticiyi durdurur', async () => {
    const { session, stop } = setup();
    const parsed = parsePairingPayload(payloadText);
    if (!parsed.ok) throw new Error('payload');
    await session.pair(parsed.payload);
    await session.pair(parsed.payload);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
