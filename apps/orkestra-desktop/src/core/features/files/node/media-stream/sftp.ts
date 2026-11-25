import type { Client, SFTPWrapper } from 'ssh2';
import type { SshConnectionManager } from '@core/primitives/ssh/api/node/ssh-connection-manager';
import type { SftpRangeReader } from './sources';

const SFTP_OPEN_TIMEOUT_MS = 10_000;
const SFTP_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Mevcut (zaten kurulmuş) SSH bağlantısı üzerinde salt okunur bir SFTP oturumu açar; yeni bağlantı
 * kurmaz, yeniden bağlanma denemez. Oturum fiziksel bağlantı başına bir kez açılıp paylaşılır;
 * SFTP alt sistemi kapalıysa bir süre yeniden denenmez.
 */
export function createSftpRangeOpener(
  manager: Pick<SshConnectionManager, 'getProxy'>,
  now: () => number = Date.now
): (connectionId: string) => Promise<SftpRangeReader | undefined> {
  const sessions = new WeakMap<Client, Promise<SFTPWrapper>>();
  const failedUntil = new Map<string, number>();

  return async (connectionId) => {
    const blockedUntil = failedUntil.get(connectionId);
    if (blockedUntil !== undefined && now() < blockedUntil) return undefined;
    const proxy = manager.getProxy(connectionId);
    if (!proxy?.isConnected) return undefined;
    const client = proxy.client;
    let session = sessions.get(client);
    if (!session) {
      const opening = openSftp(client);
      session = opening;
      sessions.set(client, opening);
      opening.then(
        (sftp) => {
          const drop = () => {
            if (sessions.get(client) === opening) sessions.delete(client);
          };
          sftp.once('close', drop);
          sftp.once('end', drop);
          sftp.once('error', drop);
        },
        () => {
          if (sessions.get(client) === opening) sessions.delete(client);
        }
      );
    }
    try {
      const sftp = await session;
      failedUntil.delete(connectionId);
      return {
        createReadStream: (path, options) => sftp.createReadStream(path, options),
      };
    } catch {
      failedUntil.set(connectionId, now() + SFTP_FAILURE_BACKOFF_MS);
      return undefined;
    }
  };
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('SFTP session timed out')),
      SFTP_OPEN_TIMEOUT_MS
    );
    timer.unref?.();
    try {
      client.sftp((error, sftp) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(sftp);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
