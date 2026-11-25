import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { createSftpRangeOpener } from './sftp';

function fakeClient(result: 'ok' | 'fail') {
  const sftp = Object.assign(new EventEmitter(), {
    createReadStream: vi.fn(() => 'stream'),
  });
  const client = {
    sftp: vi.fn((callback: (error: Error | undefined, value: unknown) => void) => {
      if (result === 'ok') callback(undefined, sftp);
      else callback(new Error('subsystem request failed'), undefined);
    }),
  };
  return { client, sftp };
}

function manager(proxy: Partial<SshClientProxy> | undefined) {
  return { getProxy: () => proxy as SshClientProxy | undefined };
}

describe('createSftpRangeOpener', () => {
  it('does not open anything for a disconnected host', async () => {
    const { client } = fakeClient('ok');
    const open = createSftpRangeOpener(
      manager({ isConnected: false, client: client as unknown as Client })
    );
    await expect(open('huawei')).resolves.toBeUndefined();
    expect(client.sftp).not.toHaveBeenCalled();
    await expect(createSftpRangeOpener(manager(undefined))('huawei')).resolves.toBeUndefined();
  });

  it('shares one SFTP session per physical connection and reopens after it closes', async () => {
    const { client, sftp } = fakeClient('ok');
    const open = createSftpRangeOpener(
      manager({ isConnected: true, client: client as unknown as Client })
    );
    const reader = await open('huawei');
    await open('huawei');
    expect(client.sftp).toHaveBeenCalledTimes(1);
    reader?.createReadStream('/home/selim/a.mp4', { start: 5, end: 9 });
    expect(sftp.createReadStream).toHaveBeenCalledWith('/home/selim/a.mp4', { start: 5, end: 9 });
    sftp.emit('close');
    await open('huawei');
    expect(client.sftp).toHaveBeenCalledTimes(2);
  });

  it('backs off after the SFTP subsystem is refused', async () => {
    let now = 0;
    const { client } = fakeClient('fail');
    const open = createSftpRangeOpener(
      manager({ isConnected: true, client: client as unknown as Client }),
      () => now
    );
    await expect(open('huawei')).resolves.toBeUndefined();
    await expect(open('huawei')).resolves.toBeUndefined();
    expect(client.sftp).toHaveBeenCalledTimes(1);
    now = 11 * 60 * 1000;
    await open('huawei');
    expect(client.sftp).toHaveBeenCalledTimes(2);
  });
});
