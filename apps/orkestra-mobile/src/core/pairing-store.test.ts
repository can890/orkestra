import { describe, expect, it } from 'vitest';
import {
  createMemorySecureStore,
  createPairingRepository,
  decodeRecord,
  recordFromPayload,
} from './pairing-store';

const payload = {
  h: 'host-1',
  n: 'Mac',
  a: ['192.168.1.5'],
  p: 4000,
  d: 'device-0001-abcdef',
  s: 'A'.repeat(43),
};

describe('PairingRepository', () => {
  it('kaydı yazar, okur ve siler', async () => {
    const repository = createPairingRepository(createMemorySecureStore());
    expect(await repository.load()).toBeNull();
    await repository.save(recordFromPayload(payload, 123));
    expect(await repository.load()).toMatchObject({ hostId: 'host-1', deviceId: payload.d, pairedAt: 123 });
    await repository.clear();
    expect(await repository.load()).toBeNull();
  });

  it('bozuk kaydı siler ve null döner', async () => {
    const store = createMemorySecureStore();
    await store.set('orkestra.pairing.v1', '{bozuk');
    const repository = createPairingRepository(store);
    expect(await repository.load()).toBeNull();
    expect(await store.get('orkestra.pairing.v1')).toBeNull();
  });

  it('adresleri günceller; geçersiz adresleri atar, boş listede değiştirmez', async () => {
    const repository = createPairingRepository(createMemorySecureStore());
    await repository.save(recordFromPayload(payload, 1));
    const updated = await repository.updateAddresses(['10.0.0.9', 'a/b', '10.0.0.9']);
    expect(updated?.addresses).toEqual(['10.0.0.9']);
    expect((await repository.updateAddresses(['kötü/adres']))?.addresses).toEqual(['10.0.0.9']);
  });

  it('kayıt yoksa updateAddresses null döner', async () => {
    const repository = createPairingRepository(createMemorySecureStore());
    expect(await repository.updateAddresses(['10.0.0.1'])).toBeNull();
  });
});

describe('decodeRecord', () => {
  it('eksik alanlarda null döner', () => {
    expect(decodeRecord(JSON.stringify({ hostId: 'x' }))).toBeNull();
    expect(decodeRecord('[]')).toBeNull();
  });
});
