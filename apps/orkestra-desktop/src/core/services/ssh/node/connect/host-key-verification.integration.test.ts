import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshConfig } from '@core/primitives/ssh/api';
import { SshConnectionManager } from '../lifecycle/ssh-connection-manager';
import type { HostKeyPrompt } from './host-key-verifier';
import { KnownHostsStore } from './known-hosts';
import { resolveSshConnectConfig } from './resolve-ssh-connect-config';

const { privateKey: hostKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer() {
  const server = new Server({ hostKeys: [hostKey] });
  server.on('connection', (client) => {
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.password === 'secret') context.accept();
      else context.reject();
    });
    client.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return address.port;
}

async function setup(confirmed: boolean) {
  const port = await startServer();
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-host-keys-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const ownFile = join(dir, 'ssh_known_hosts');
  // Only the temporary file is visible; the machine's real ~/.ssh files are never read.
  const store = new KnownHostsStore({
    ownFile,
    readFile: async (path) => {
      if (!path.startsWith(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return await readFile(path, 'utf8');
    },
  });
  const confirm = vi.fn(async (_prompt: HostKeyPrompt) => confirmed);
  const manager = new SshConnectionManager();
  cleanups.push(() => manager.disconnectAll());
  const config: SshConfig & { password: string } = {
    id: '',
    name: 'Host key test',
    host: '127.0.0.1',
    port,
    username: 'alice',
    authType: 'password',
    password: 'secret',
  };
  let attempt = 0;
  const connect = () =>
    manager.createConnection(
      `host-key-${(attempt += 1)}`,
      () =>
        resolveSshConnectConfig({ kind: 'transient', config }, { hostKeys: { store, confirm } }),
      { ephemeral: true }
    );
  return { port, ownFile, confirm, connect };
}

describe('host key verification over a real SSH handshake', () => {
  it('asks once, saves the key, then connects silently with the known key type preferred', async () => {
    const { port, ownFile, confirm, connect } = await setup(true);

    const first = await connect();
    expect(first.isConnected).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      host: '127.0.0.1',
      port,
      knownHostName: `[127.0.0.1]:${port}`,
      keyType: 'ssh-rsa',
    });
    expect(await readFile(ownFile, 'utf8')).toMatch(
      new RegExp(`^\\[127\\.0\\.0\\.1\\]:${port} ssh-rsa [A-Za-z0-9+/=]+\\n$`)
    );

    const second = await connect();
    expect(second.isConnected).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('refuses the connection when the key is not confirmed', async () => {
    const { ownFile, connect } = await setup(false);

    await expect(connect()).rejects.toMatchObject({
      kind: 'host-key',
      message: expect.stringContaining('onaylanmadı'),
    });
    await expect(readFile(ownFile, 'utf8')).rejects.toThrow();
  });

  it('blocks a server whose key differs from the recorded one, without asking', async () => {
    const { port, ownFile, confirm, connect } = await setup(true);
    const { publicKey: otherKey } = generateKeyPairSync('ed25519');
    const otherRaw = Buffer.from(otherKey.export({ format: 'jwk' }).x!, 'base64url');
    const sshString = (value: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(value.length);
      return Buffer.concat([length, value]);
    };
    // Record a different RSA-typed key for this host:port so the offered key no longer matches.
    const fakeRsa = Buffer.concat([sshString(Buffer.from('ssh-rsa')), sshString(otherRaw)]);
    await writeFile(ownFile, `[127.0.0.1]:${port} ssh-rsa ${fakeRsa.toString('base64')}\n`);

    await expect(connect()).rejects.toMatchObject({
      kind: 'host-key',
      message: expect.stringContaining('anahtarı değişti'),
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
