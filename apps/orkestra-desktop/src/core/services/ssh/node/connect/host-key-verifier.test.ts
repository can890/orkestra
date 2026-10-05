import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createHostKeyVerification,
  normalizeHostKeyPolicy,
  preferredHostKeyAlgorithms,
  serializeHostKeyPrompts,
  type HostKeyPolicy,
  type HostKeyPrompt,
} from './host-key-verifier';
import { hostKeyFingerprint, KnownHostsStore, type HostKeyCheck } from './known-hosts';

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

function ed25519Blob(): Buffer {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]);
}

function setup(check: HostKeyCheck | Error, policy: HostKeyPolicy, confirmed = true) {
  const store = Object.assign(Object.create(KnownHostsStore.prototype) as KnownHostsStore, {
    check: vi.fn(async () => {
      if (check instanceof Error) throw check;
      return check;
    }),
    add: vi.fn(async () => {}),
  });
  Object.defineProperty(store, 'ownFile', { value: '/data/ssh_known_hosts' });
  const confirm = vi.fn(async (_prompt: HostKeyPrompt) => confirmed);
  const verification = createHostKeyVerification({
    host: 'server.example.com',
    port: 2222,
    knownHostName: '[server.example.com]:2222',
    policy,
    sources: {},
    deps: { store, confirm },
  });
  const run = (key: Buffer) =>
    new Promise<boolean>((resolve) => verification.hostVerifier(key, resolve));
  return { store, confirm, verification, run };
}

describe('host key verification', () => {
  it('maps StrictHostKeyChecking values to a policy', () => {
    expect(normalizeHostKeyPolicy(undefined)).toBe('ask');
    expect(normalizeHostKeyPolicy('ask')).toBe('ask');
    expect(normalizeHostKeyPolicy('YES')).toBe('yes');
    expect(normalizeHostKeyPolicy('true')).toBe('yes');
    expect(normalizeHostKeyPolicy('off')).toBe('no');
    expect(normalizeHostKeyPolicy('accept-new')).toBe('accept-new');
  });

  it('connects to a known key without asking or writing', async () => {
    const { run, confirm, store, verification } = setup({ kind: 'match' }, 'ask');

    await expect(run(ed25519Blob())).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
    expect(verification.failure()).toBeUndefined();
  });

  it('asks for an unknown key and saves it only after confirmation', async () => {
    const key = ed25519Blob();
    const accepted = setup({ kind: 'unknown', knownKeyTypes: ['ssh-rsa'] }, 'ask', true);

    await expect(accepted.run(key)).resolves.toBe(true);
    expect(accepted.confirm).toHaveBeenCalledWith({
      host: 'server.example.com',
      port: 2222,
      knownHostName: '[server.example.com]:2222',
      keyType: 'ssh-ed25519',
      fingerprint: hostKeyFingerprint(key),
      otherKeyTypes: ['ssh-rsa'],
    });
    expect(accepted.store.add).toHaveBeenCalledWith('[server.example.com]:2222', key);

    const declined = setup({ kind: 'unknown', knownKeyTypes: [] }, 'ask', false);
    await expect(declined.run(key)).resolves.toBe(false);
    expect(declined.store.add).not.toHaveBeenCalled();
    expect(declined.verification.failure()).toMatchObject({ kind: 'host-key' });
    expect(declined.verification.failure()?.message).toContain('onaylanmadı');
  });

  it('blocks a changed key without asking and explains how to clear it', async () => {
    const { run, confirm, verification } = setup(
      {
        kind: 'changed',
        knownFingerprints: ['SHA256:eski'],
        files: ['/home/test/.ssh/known_hosts'],
      },
      'no'
    );

    await expect(run(ed25519Blob())).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    const message = verification.failure()?.message ?? '';
    expect(message).toContain('anahtarı değişti');
    expect(message).toContain('SHA256:eski');
    expect(message).toContain(
      "ssh-keygen -R '[server.example.com]:2222' -f /home/test/.ssh/known_hosts"
    );
  });

  it('blocks revoked keys and unknown keys under StrictHostKeyChecking=yes', async () => {
    const revoked = setup({ kind: 'revoked' }, 'ask');
    await expect(revoked.run(ed25519Blob())).resolves.toBe(false);
    expect(revoked.verification.failure()?.message).toContain('iptal edilmiş');

    const strict = setup({ kind: 'unknown', knownKeyTypes: [] }, 'yes');
    await expect(strict.run(ed25519Blob())).resolves.toBe(false);
    expect(strict.confirm).not.toHaveBeenCalled();
    expect(strict.verification.failure()?.message).toContain('StrictHostKeyChecking=yes');
  });

  it.each(['accept-new', 'no'] as const)(
    'saves an unknown key without asking under %s',
    async (policy) => {
      const { run, confirm, store } = setup({ kind: 'unknown', knownKeyTypes: [] }, policy);

      await expect(run(ed25519Blob())).resolves.toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(store.add).toHaveBeenCalledTimes(1);
    }
  );

  it('fails closed when the known hosts cannot be read', async () => {
    const { run, verification } = setup(new Error('disk hatası'), 'ask');

    await expect(run(ed25519Blob())).resolves.toBe(false);
    expect(verification.failure()?.message).toContain('doğrulanamadı: disk hatası');
  });

  it('prefers the algorithms of known key types', () => {
    expect(preferredHostKeyAlgorithms(['ssh-rsa', 'ssh-ed25519'])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-ed25519',
    ]);
    expect(preferredHostKeyAlgorithms(['sk-ssh-ed25519@openssh.com'])).toEqual([]);
  });

  it('shows one prompt at a time and shares the answer for the same host and key', async () => {
    const order: string[] = [];
    let release: (value: boolean) => void = () => {};
    const show = vi.fn(async (prompt: HostKeyPrompt) => {
      order.push(`show ${prompt.knownHostName}`);
      if (prompt.knownHostName === 'a') return await new Promise<boolean>((r) => (release = r));
      return false;
    });
    const confirm = serializeHostKeyPrompts(show);
    const prompt = (knownHostName: string): HostKeyPrompt => ({
      host: knownHostName,
      port: 22,
      knownHostName,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:x',
      otherKeyTypes: [],
    });

    const first = confirm(prompt('a'));
    const duplicate = confirm(prompt('a'));
    const second = confirm(prompt('b'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['show a']);

    release(true);
    await expect(first).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(order).toEqual(['show a', 'show b']);
    expect(show).toHaveBeenCalledTimes(2);
  });
});
