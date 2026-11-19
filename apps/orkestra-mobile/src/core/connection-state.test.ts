import { RemoteHandshakeError } from '@orkestra/wire/remote';
import { describe, expect, it } from 'vitest';
import {
  classifyConnectionError,
  connectionReducer,
  describeStatus,
  IDLE_STATUS,
  type ConnectionEvent,
  type ConnectionStatus,
} from './connection-state';

function run(events: ConnectionEvent[], from: ConnectionStatus = IDLE_STATUS): ConnectionStatus {
  return events.reduce(connectionReducer, from);
}

describe('connectionReducer', () => {
  it('bağlanma → hazır → kopma → yeniden deneme → hazır', () => {
    expect(run([{ type: 'start' }])).toEqual({ kind: 'connecting' });
    expect(run([{ type: 'start' }, { type: 'ready', hostName: 'Mac' }])).toEqual({
      kind: 'connected',
      hostName: 'Mac',
    });
    const reconnecting = run([
      { type: 'start' },
      { type: 'ready', hostName: 'Mac' },
      { type: 'disconnected' },
      { type: 'attempt-failed', issue: 'unreachable' },
      { type: 'attempt-failed', issue: 'timeout' },
    ]);
    expect(reconnecting).toEqual({ kind: 'reconnecting', issue: 'timeout', attempts: 2 });
    expect(connectionReducer(reconnecting, { type: 'ready', hostName: 'Mac' })).toEqual({
      kind: 'connected',
      hostName: 'Mac',
    });
  });

  it('ilk bağlanma denemesi başarısız olunca yeniden denemeye geçer', () => {
    expect(run([{ type: 'start' }, { type: 'attempt-failed', issue: 'unreachable' }])).toEqual({
      kind: 'reconnecting',
      issue: 'unreachable',
      attempts: 1,
    });
  });

  it('kalıcı hata sonrası olaylar durumu değiştirmez', () => {
    const failed = run([{ type: 'start' }, { type: 'terminal', reason: 'auth' }]);
    expect(failed).toEqual({ kind: 'failed', reason: 'auth' });
    expect(connectionReducer(failed, { type: 'ready', hostName: 'x' })).toBe(failed);
    expect(connectionReducer(failed, { type: 'disconnected' })).toBe(failed);
    expect(connectionReducer(failed, { type: 'attempt-failed', issue: 'busy' })).toBe(failed);
  });

  it('durdurulunca boşa döner ve geç gelen olayları yok sayar', () => {
    const idle = run([{ type: 'start' }, { type: 'stop' }]);
    expect(idle).toEqual({ kind: 'idle' });
    expect(connectionReducer(idle, { type: 'ready', hostName: 'x' })).toBe(idle);
    expect(connectionReducer(idle, { type: 'terminal', reason: 'auth' })).toBe(idle);
  });
});

describe('classifyConnectionError', () => {
  it('yanlış sır ve sürüm uyumsuzluğunu kalıcı sayar', () => {
    expect(classifyConnectionError(new RemoteHandshakeError('AUTH_FAILED', 'x')).terminal).toBe(
      'auth'
    );
    expect(
      classifyConnectionError(new RemoteHandshakeError('VERSION_UNSUPPORTED', 'x')).terminal
    ).toBe('version');
  });
  it('hız sınırında bekleme süresini taşır', () => {
    expect(classifyConnectionError(new RemoteHandshakeError('RATE_LIMITED', 'x', 30_000))).toEqual({
      issue: 'rate-limited',
      terminal: null,
      retryAfterMs: 30_000,
    });
  });
  it('ulaşılamama ve zaman aşımını yeniden denenebilir sayar', () => {
    expect(
      classifyConnectionError(new RemoteHandshakeError('UNREACHABLE', 'x')).terminal
    ).toBeNull();
    expect(classifyConnectionError(new RemoteHandshakeError('TIMEOUT', 'x')).issue).toBe('timeout');
    expect(classifyConnectionError(new Error('?'))).toMatchObject({
      issue: 'unknown',
      terminal: null,
    });
  });
});

describe('describeStatus', () => {
  it('Türkçe durum metni üretir', () => {
    expect(describeStatus({ kind: 'connected', hostName: 'Mac' })).toBe('Mac ile bağlı');
    expect(describeStatus({ kind: 'failed', reason: 'auth' })).toContain('Yeniden eşleştirin');
  });
});
