import { describe, expect, it } from 'vitest';
import { MAX_OUTSIDE_AGENT_CLIENTS } from '@core/features/outside-agents/api/contract';
import { hashOutsideAgentToken, OutsideAgentClientRegistry } from './client-registry';
import { MemoryPersistence, MemorySecretStore } from './testing/fakes';

function setup() {
  const persistence = new MemoryPersistence();
  const secrets = new MemorySecretStore();
  let now = 1_000;
  const registry = new OutsideAgentClientRegistry({ persistence, secrets, now: () => now });
  return { persistence, secrets, registry, advance: (ms: number) => (now += ms) };
}

describe('OutsideAgentClientRegistry', () => {
  it('is off by default with the default port', async () => {
    const { registry } = setup();
    expect(await registry.getSettings()).toEqual({ enabled: false, port: 47660 });
  });

  it('issues a token, stores only its hash in the secret store and authenticates it', async () => {
    const { registry, secrets, persistence } = setup();
    const created = await registry.createClient('Claude Code', 'read');
    expect(created.success).toBe(true);
    if (!created.success) return;
    const { token, client } = created.data;
    expect(token).toMatch(/^orkmcp_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    // Ne kalıcı durumda ne de sır deposunda belirtecin kendisi bulunur.
    expect(JSON.stringify(persistence.state)).not.toContain(token);
    const stored = [...secrets.values.values()].map((value) => value.expose());
    expect(stored).toEqual([hashOutsideAgentToken(token).toString('hex')]);
    expect(stored.join()).not.toContain(token);

    expect(await registry.authenticate(token)).toEqual({
      clientId: client.id,
      name: 'Claude Code',
      access: 'read',
    });
  });

  it('rejects wrong, malformed and foreign tokens', async () => {
    const { registry } = setup();
    const created = await registry.createClient('Hermes', 'act');
    if (!created.success) throw new Error('create failed');
    const { token, client } = created.data;
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await registry.authenticate(tampered)).toBeNull();
    expect(await registry.authenticate('')).toBeNull();
    expect(await registry.authenticate('Bearer nonsense')).toBeNull();
    expect(
      await registry.authenticate(`orkmcp_${'0'.repeat(16)}_${token.split('_').at(-1)}`)
    ).toBeNull();
    expect(await registry.authenticate(token)).toMatchObject({ clientId: client.id });
  });

  it('survives a restart by reading the hash back from the secret store', async () => {
    const { registry, secrets, persistence } = setup();
    const created = await registry.createClient('AtlasBar', 'read');
    if (!created.success) throw new Error('create failed');
    const reopened = new OutsideAgentClientRegistry({ persistence, secrets });
    expect(await reopened.authenticate(created.data.token)).toMatchObject({ name: 'AtlasBar' });
  });

  it('revoke removes the client and its secret immediately', async () => {
    const { registry, secrets } = setup();
    const created = await registry.createClient('Codex', 'act');
    if (!created.success) throw new Error('create failed');
    const revoked = await registry.revokeClient(created.data.client.id);
    expect(revoked.success).toBe(true);
    expect(await registry.authenticate(created.data.token)).toBeNull();
    expect(registry.currentAccess(created.data.client.id)).toBeNull();
    expect(secrets.values.size).toBe(0);
    expect(await registry.listClients()).toEqual([]);
    const again = await registry.revokeClient(created.data.client.id);
    expect(again.success).toBe(false);
  });

  it('changes the access level of an existing client', async () => {
    const { registry } = setup();
    const created = await registry.createClient('Bot', 'read');
    if (!created.success) throw new Error('create failed');
    expect(registry.currentAccess(created.data.client.id)).toBe('read');
    await registry.setClientAccess(created.data.client.id, 'act');
    expect(registry.currentAccess(created.data.client.id)).toBe('act');
    expect(await registry.authenticate(created.data.token)).toMatchObject({ access: 'act' });
  });

  it('validates names and enforces the client limit', async () => {
    const { registry } = setup();
    expect((await registry.createClient('   ', 'read')).success).toBe(false);
    for (let index = 0; index < MAX_OUTSIDE_AGENT_CLIENTS; index += 1) {
      expect((await registry.createClient(`client ${index}`, 'read')).success).toBe(true);
    }
    const over = await registry.createClient('one too many', 'read');
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.type).toBe('limit_reached');
  });

  it('records last use, writing to disk at most once a minute', async () => {
    const { registry, persistence, advance } = setup();
    const created = await registry.createClient('Claude Code', 'read');
    if (!created.success) throw new Error('create failed');
    const id = created.data.client.id;
    const savesBefore = persistence.saves;
    registry.touch(id);
    await registry.listClients();
    advance(5_000);
    registry.touch(id);
    const [client] = await registry.listClients();
    expect(client?.lastUsedAt).toBe(6_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persistence.saves).toBe(savesBefore + 1);
  });

  it('ignores corrupt persisted state', async () => {
    const persistence = new MemoryPersistence();
    persistence.state = { garbage: true } as never;
    const registry = new OutsideAgentClientRegistry({
      persistence,
      secrets: new MemorySecretStore(),
    });
    expect(await registry.getSettings()).toEqual({ enabled: false, port: 47660 });
  });
});
