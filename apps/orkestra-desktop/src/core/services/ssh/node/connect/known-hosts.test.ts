import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hostKeyFingerprint,
  hostKeyType,
  knownHostName,
  KnownHostsStore,
  parseKnownHosts,
} from './known-hosts';

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

/** Gerçek bir ed25519 açık anahtarını SSH kablo biçiminde üretir. */
function ed25519Blob(): Buffer {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]);
}

function fakeBlob(type: string): Buffer {
  return Buffer.concat([sshString(type), sshString(randomBytes(32))]);
}

function hashedHost(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest('base64');
  return `|1|${salt.toString('base64')}|${hash}`;
}

function memoryStore(files: Record<string, string>) {
  const contents = new Map(Object.entries(files));
  const store = new KnownHostsStore({
    ownFile: '/data/ssh_known_hosts',
    readFile: async (path) => {
      const value = contents.get(path);
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return value;
    },
    appendFile: async (path, data) => {
      contents.set(path, (contents.get(path) ?? '') + data);
    },
    ensureDirectory: async () => {},
  });
  return { store, contents };
}

const USER_FILE = '/home/test/.ssh/known_hosts';
const sources = { userFiles: [USER_FILE], globalFiles: [] };

describe('known_hosts', () => {
  it('parses entries and skips comments, blanks, unknown markers and short lines', () => {
    const entries = parseKnownHosts(
      [
        '# yorum',
        '',
        'a.example.com,10.0.0.1 ssh-ed25519 AAAA key-comment',
        '@revoked * ssh-rsa BBBB',
        '@cert-authority *.example.com ssh-ed25519 CCCC',
        '@unknown host ssh-ed25519 DDDD',
        'eksik-satir ssh-ed25519',
      ].join('\n')
    );
    expect(entries).toEqual([
      { marker: null, hosts: ['a.example.com', '10.0.0.1'], keyType: 'ssh-ed25519', key: 'AAAA' },
      { marker: 'revoked', hosts: ['*'], keyType: 'ssh-rsa', key: 'BBBB' },
      { marker: 'cert-authority', hosts: ['*.example.com'], keyType: 'ssh-ed25519', key: 'CCCC' },
    ]);
  });

  it('names hosts the way OpenSSH records them', () => {
    expect(knownHostName('example.com', 22)).toBe('example.com');
    expect(knownHostName('example.com', 2222)).toBe('[example.com]:2222');
  });

  it('reads the key type and an OpenSSH-style fingerprint from the key blob', () => {
    const blob = ed25519Blob();
    expect(hostKeyType(blob)).toBe('ssh-ed25519');
    expect(hostKeyFingerprint(blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(hostKeyType(Buffer.from([0, 0]))).toBeNull();
  });

  it('matches plain, hashed, wildcard and port-specific entries', async () => {
    const plain = ed25519Blob();
    const hashed = ed25519Blob();
    const wildcard = ed25519Blob();
    const ported = ed25519Blob();
    const { store } = memoryStore({
      [USER_FILE]: [
        `plain.example.com ssh-ed25519 ${plain.toString('base64')}`,
        `${hashedHost('hashed.example.com')} ssh-ed25519 ${hashed.toString('base64')}`,
        `*.wild.example.com,!bad.wild.example.com ssh-ed25519 ${wildcard.toString('base64')}`,
        `[ported.example.com]:2222 ssh-ed25519 ${ported.toString('base64')}`,
      ].join('\n'),
    });

    await expect(store.check('plain.example.com', plain, sources)).resolves.toEqual({
      kind: 'match',
    });
    await expect(store.check('hashed.example.com', hashed, sources)).resolves.toEqual({
      kind: 'match',
    });
    await expect(store.check('a.wild.example.com', wildcard, sources)).resolves.toEqual({
      kind: 'match',
    });
    await expect(store.check('bad.wild.example.com', wildcard, sources)).resolves.toMatchObject({
      kind: 'unknown',
    });
    await expect(store.check('[ported.example.com]:2222', ported, sources)).resolves.toEqual({
      kind: 'match',
    });
    // A port-22 entry does not vouch for another port, and vice versa.
    await expect(store.check('ported.example.com', ported, sources)).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('reports a changed key of the same type with both fingerprints and the file', async () => {
    const known = ed25519Blob();
    const offered = ed25519Blob();
    const { store } = memoryStore({
      [USER_FILE]: `server.example.com ssh-ed25519 ${known.toString('base64')}`,
    });

    await expect(store.check('server.example.com', offered, sources)).resolves.toEqual({
      kind: 'changed',
      knownFingerprints: [hostKeyFingerprint(known)],
      files: [USER_FILE],
    });
  });

  it('treats another key type as unknown but remembers which types are known', async () => {
    const { store } = memoryStore({
      [USER_FILE]: `server.example.com ssh-rsa ${fakeBlob('ssh-rsa').toString('base64')}`,
    });

    await expect(store.check('server.example.com', ed25519Blob(), sources)).resolves.toEqual({
      kind: 'unknown',
      knownKeyTypes: ['ssh-rsa'],
    });
    await expect(store.knownKeyTypes('server.example.com', sources)).resolves.toEqual(['ssh-rsa']);
    await expect(store.knownKeyTypes('other.example.com', sources)).resolves.toEqual([]);
  });

  it('refuses revoked keys even when a matching entry exists', async () => {
    const blob = ed25519Blob();
    const { store } = memoryStore({
      [USER_FILE]: [
        `server.example.com ssh-ed25519 ${blob.toString('base64')}`,
        `@revoked * ssh-ed25519 ${blob.toString('base64')}`,
      ].join('\n'),
    });

    await expect(store.check('server.example.com', blob, sources)).resolves.toEqual({
      kind: 'revoked',
    });
  });

  it('appends confirmed keys to its own file only, and reads them back', async () => {
    const blob = ed25519Blob();
    const { store, contents } = memoryStore({ [USER_FILE]: '' });

    await store.add('[server.example.com]:2222', blob);

    expect(contents.get('/data/ssh_known_hosts')).toBe(
      `[server.example.com]:2222 ssh-ed25519 ${blob.toString('base64')}\n`
    );
    expect(contents.get(USER_FILE)).toBe('');
    await expect(store.check('[server.example.com]:2222', blob, sources)).resolves.toEqual({
      kind: 'match',
    });
  });
});
