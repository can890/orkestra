// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/desktop/src/preview/BrowserImport/ChromiumKeys.ts
//
// Chromium OSCrypt anahtar türetimi. macOS'ta "<Tarayıcı> Safe Storage" parolası anahtar
// zincirinden normal sistem istemiyle alınır; Linux'ta v10 için sabit "peanuts" parolası, v11 için
// (varsa) Secret Service parolası kullanılır. Parola ve türetilen anahtar asla saklanmaz ya da
// loglanmaz; yalnızca bu içe aktarma süresince bellekte tutulur.
import { execFile } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';

const KEY_SALT = 'saltysalt';
const KEY_LENGTH = 16;
export const MAC_KEY_ITERATIONS = 1003;
export const LINUX_KEY_ITERATIONS = 1;
/** Linux'ta anahtar zinciri yokken Chromium'un kullandığı belgelenmiş yedek parola. */
export const LINUX_FALLBACK_PASSPHRASE = 'peanuts';

export type ChromiumKeyFailure =
  | 'needsKeychainApproval'
  | 'keychainItemMissing'
  | 'keychainUnavailable'
  | 'unsupportedPlatform'
  | 'readFailed';

export class ChromiumKeyError extends Error {
  constructor(readonly reason: ChromiumKeyFailure) {
    super(`Could not obtain the Chromium cookie key: ${reason}.`);
    this.name = 'ChromiumKeyError';
  }
}

export type ChromiumKeyMaterial = {
  cbcV10?: Buffer;
  cbcV11?: Buffer;
  cbcV11Error?: ChromiumKeyError;
  /** Bazı Linux istemcileri boş parolayla şifreler; başarısızlıkta bu da denenir (crbug.com/1195256). */
  cbcEmpty?: Buffer;
};

export function deriveChromiumKey(passphrase: string, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, 'sha1');
}

/**
 * İşletim sistemi anahtar zincirinden tarayıcının "Safe Storage" parolasını okuyan arayüz.
 * Testler sahte bir uygulama verir; gerçek anahtar zincirine yalnızca üretimde dokunulur.
 */
export type SafeStorageSecretReader = {
  /** macOS anahtar zinciri: `service`/`account` genel parola öğesi. */
  readMacKeychain(service: string, account: string): Promise<string>;
  /** Linux Secret Service: `application` özniteliğiyle saklanan Chromium parolası. */
  readLinuxSecret(application: string): Promise<string>;
};

type ExecFileFn = (
  file: string,
  args: readonly string[],
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void
) => void;

const defaultExecFile: ExecFileFn = (file, args, callback) => {
  execFile(file, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) =>
    callback(error as (Error & { code?: unknown }) | null, String(stdout ?? ''))
  );
};

// `security` çıkış kodları: 44 = öğe bulunamadı, 51/128 = kullanıcı reddetti ya da iptal etti.
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Üretim okuyucusu. macOS'ta `/usr/bin/security find-generic-password -w` normal anahtar zinciri
 * istemini gösterir ("İzin Ver"/"Reddet"); Linux'ta `secret-tool lookup` kullanılır. Çıktı yalnızca
 * dönüş değeri olarak taşınır, hiçbir yere yazılmaz.
 */
export function createSystemSafeStorageSecretReader(
  exec: ExecFileFn = defaultExecFile
): SafeStorageSecretReader {
  const run = (file: string, args: readonly string[]) =>
    new Promise<string>((resolve, reject) => {
      exec(file, args, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.replace(/\r?\n$/, ''));
      });
    });

  return {
    async readMacKeychain(service, account) {
      let secret: string;
      try {
        secret = await run('/usr/bin/security', [
          'find-generic-password',
          '-w',
          '-s',
          service,
          '-a',
          account,
        ]);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOENT') throw new ChromiumKeyError('keychainUnavailable');
        throw new ChromiumKeyError(
          code === SECURITY_ITEM_NOT_FOUND ? 'keychainItemMissing' : 'needsKeychainApproval'
        );
      }
      if (!secret) throw new ChromiumKeyError('keychainItemMissing');
      return secret;
    },
    async readLinuxSecret(application) {
      let secret: string;
      try {
        secret = await run('secret-tool', ['lookup', 'application', application]);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // secret-tool eşleşme olmadığında 1 ile çıkar; araç yoksa ENOENT.
        throw new ChromiumKeyError(code === 1 ? 'keychainItemMissing' : 'keychainUnavailable');
      }
      if (!secret) throw new ChromiumKeyError('keychainItemMissing');
      return secret;
    },
  };
}

export type ChromiumKeyRequest = {
  platform: NodeJS.Platform;
  keychainService: string | undefined;
  keychainAccount: string | undefined;
  linuxSecretApplication: string | undefined;
};

export async function resolveChromiumKeys(
  request: ChromiumKeyRequest,
  secrets: SafeStorageSecretReader
): Promise<ChromiumKeyMaterial> {
  if (request.platform === 'darwin') {
    if (!request.keychainService || !request.keychainAccount) {
      throw new ChromiumKeyError('unsupportedPlatform');
    }
    const secret = await secrets.readMacKeychain(request.keychainService, request.keychainAccount);
    return { cbcV10: deriveChromiumKey(secret, MAC_KEY_ITERATIONS) };
  }

  if (request.platform === 'linux') {
    // v10 her zaman yedek parolayı kullanır; anahtar zinciri parolası ayrıca v11'i açar.
    let keyringSecret: string | undefined;
    let keyringError: ChromiumKeyError | undefined;
    if (request.linuxSecretApplication) {
      try {
        keyringSecret = await secrets.readLinuxSecret(request.linuxSecretApplication);
      } catch (error) {
        const keyError =
          error instanceof ChromiumKeyError ? error : new ChromiumKeyError('keychainUnavailable');
        // Açık reddetme dışında hiçbir hata v10 çerezlerini engellememeli.
        if (keyError.reason === 'needsKeychainApproval') throw keyError;
        keyringError = keyError;
      }
    }
    return {
      cbcV10: deriveChromiumKey(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS),
      ...(keyringSecret !== undefined
        ? { cbcV11: deriveChromiumKey(keyringSecret, LINUX_KEY_ITERATIONS) }
        : keyringError
          ? { cbcV11Error: keyringError }
          : {}),
      cbcEmpty: deriveChromiumKey('', LINUX_KEY_ITERATIONS),
    };
  }

  // Windows'ta Chromium 127+ uygulamaya bağlı şifreleme kullanır; desteklenmez.
  throw new ChromiumKeyError('unsupportedPlatform');
}
