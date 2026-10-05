// SSH sunucu anahtarı doğrulaması (OpenSSH'ın StrictHostKeyChecking davranışını izler).
import type { ServerHostKeyAlgorithm } from 'ssh2';
import { SshConnectionFailure } from '@core/primitives/ssh/api/node/connection-control';
import {
  hostKeyFingerprint,
  hostKeyType,
  type KnownHostsSources,
  type KnownHostsStore,
} from './known-hosts';

/** Bilinmeyen bir sunucu anahtarı için kullanıcıya gösterilen bilgiler. */
export type HostKeyPrompt = {
  host: string;
  port: number;
  /** known_hosts'a yazılacak ad (`ad` ya da `[ad]:port`). */
  knownHostName: string;
  keyType: string;
  fingerprint: string;
  /** Bu host için daha önce kaydedilmiş farklı türdeki anahtarlar; doluysa ayrıca uyarılır. */
  otherKeyTypes: string[];
};

/** Kullanıcı anahtarı onaylarsa true döner. */
export type ConfirmHostKey = (prompt: HostKeyPrompt) => Promise<boolean>;

export type HostKeyPolicy = 'ask' | 'yes' | 'no' | 'accept-new';

export type HostKeyVerificationDeps = {
  store: KnownHostsStore;
  confirm: ConfirmHostKey;
};

export function normalizeHostKeyPolicy(value: string | undefined): HostKeyPolicy {
  switch (value?.trim().toLowerCase()) {
    case 'yes':
    case 'true':
      return 'yes';
    case 'no':
    case 'off':
    case 'false':
      return 'no';
    case 'accept-new':
      return 'accept-new';
    default:
      return 'ask';
  }
}

/** Komut satırı için tırnaklar; `[ad]:port` gibi köşeli parantezler kabukta kalıp sayılır. */
function quoteArg(value: string): string {
  return /^[A-Za-z0-9._:@/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export type HostKeyVerification = {
  /** ssh2 `hostVerifier`: sonucu `verify` ile asenkron bildirir. */
  hostVerifier: (key: Buffer, verify: (permitted: boolean) => void) => void;
  /** Anahtar reddedildiyse nedeni; bağlantı hatası bununla sınıflandırılır. */
  failure: () => SshConnectionFailure | undefined;
};

export function createHostKeyVerification(options: {
  host: string;
  port: number;
  knownHostName: string;
  policy: HostKeyPolicy;
  sources: KnownHostsSources;
  deps: HostKeyVerificationDeps;
}): HostKeyVerification {
  const { host, port, knownHostName, policy, sources, deps } = options;
  const label = `${host}:${port}`;
  let failure: SshConnectionFailure | undefined;
  const reject = (message: string): false => {
    failure = new SshConnectionFailure('host-key', message);
    return false;
  };

  const decide = async (key: Buffer): Promise<boolean> => {
    const keyType = hostKeyType(key) ?? 'bilinmeyen tür';
    const fingerprint = hostKeyFingerprint(key);
    const check = await deps.store.check(knownHostName, key, sources);
    switch (check.kind) {
      case 'match':
        return true;
      case 'revoked':
        return reject(
          `${label} sunucusunun anahtarı iptal edilmiş olarak işaretli (${keyType} ${fingerprint}); bağlanılmadı.`
        );
      case 'changed': {
        const file = check.files[0] ?? deps.store.ownFile;
        return reject(
          `${label} sunucusunun anahtarı değişti. Kayıtlı: ${check.knownFingerprints.join(', ')}; ` +
            `gelen: ${keyType} ${fingerprint}. Araya biri girmiş olabileceği için bağlanılmadı. ` +
            `Anahtarı sunucuda bilerek değiştirdiyseniz eski kaydı silin: ` +
            `ssh-keygen -R ${quoteArg(knownHostName)} -f ${quoteArg(file)}`
        );
      }
      case 'unknown': {
        if (policy === 'yes') {
          return reject(
            `${label} sunucusunun anahtarı bilinen sunucular arasında yok ve SSH ayarlarınızda ` +
              `StrictHostKeyChecking=yes tanımlı. Anahtarı önce terminalden bağlanarak doğrulayın.`
          );
        }
        if (policy === 'ask') {
          const confirmed = await deps.confirm({
            host,
            port,
            knownHostName,
            keyType,
            fingerprint,
            otherKeyTypes: check.knownKeyTypes,
          });
          if (!confirmed) {
            return reject(`${label} sunucusunun anahtarı onaylanmadı; bağlantı iptal edildi.`);
          }
        }
        await deps.store.add(knownHostName, key);
        return true;
      }
    }
  };

  return {
    hostVerifier: (key, verify) => {
      decide(key).then(verify, (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        reject(`${label} sunucusunun anahtarı doğrulanamadı: ${reason}`);
        verify(false);
      });
    },
    failure: () => failure,
  };
}

const HOST_KEY_ALGORITHMS_BY_TYPE: Readonly<Record<string, readonly ServerHostKeyAlgorithm[]>> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

/**
 * Bilinen anahtar türleri için önce denenecek sunucu anahtarı algoritmaları. Sunucu böylece
 * kayıtlı türde bir anahtar sunar; farklı türle "bilinmeyen anahtar" gibi görünmesi önlenir.
 */
export function preferredHostKeyAlgorithms(
  knownKeyTypes: readonly string[]
): ServerHostKeyAlgorithm[] {
  return [...new Set(knownKeyTypes.flatMap((type) => HOST_KEY_ALGORITHMS_BY_TYPE[type] ?? []))];
}

/**
 * Onay pencerelerini sıraya koyar; aynı host ve anahtar için bekleyen bir soru varsa yeni pencere
 * açmak yerine onun cevabını paylaşır (ör. aynı makineye aynı anda iki bağlantı).
 */
export function serializeHostKeyPrompts(show: ConfirmHostKey): ConfirmHostKey {
  const pending = new Map<string, Promise<boolean>>();
  let queue: Promise<unknown> = Promise.resolve();
  return (prompt) => {
    const key = `${prompt.knownHostName} ${prompt.fingerprint}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const answer = queue
      .then(() => show(prompt))
      .finally(() => {
        pending.delete(key);
      });
    queue = answer.catch(() => false);
    pending.set(key, answer);
    return answer;
  };
}
