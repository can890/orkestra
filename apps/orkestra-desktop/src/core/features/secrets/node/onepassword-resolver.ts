import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OnePasswordStatus } from '@core/features/secrets/api/contract';

const execFileAsync = promisify(execFile);
const OP_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

export type OpCommandRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultOpRunner: OpCommandRunner = async (args) => {
  return execFileAsync('op', args, {
    timeout: OP_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
};

export function isOpReference(value: string): boolean {
  return value.trim().startsWith('op://');
}

function maskSecretPreview(value: string): string {
  const clean = value.trim();
  if (clean.length <= 4) return '••••';
  return `${clean.slice(0, 2)}${'•'.repeat(Math.min(8, clean.length - 4))}${clean.slice(-2)}`;
}

type CacheEntry = {
  value: string;
  expiresAt: number;
};

export class OnePasswordResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly runOp: OpCommandRunner = defaultOpRunner) {}

  clearCache(): void {
    this.cache.clear();
  }

  async checkCli(account?: string): Promise<OnePasswordStatus> {
    let version: string | undefined;
    try {
      const { stdout } = await this.runOp(['--version']);
      version = stdout.trim() || undefined;
    } catch (error) {
      return {
        installed: false,
        signedIn: false,
        error:
          error instanceof Error && /ENOENT/.test(error.message)
            ? '1Password CLI (`op`) sistemde kurulu değil.'
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }

    try {
      const args = ['whoami', '--format', 'json'];
      if (account?.trim()) {
        args.push('--account', account.trim());
      }
      const { stdout } = await this.runOp(args);
      let accountEmail: string | undefined;
      try {
        const parsed = JSON.parse(stdout) as { email?: unknown; url?: unknown };
        if (typeof parsed.email === 'string') accountEmail = parsed.email;
      } catch {
        // JSON ayrıştırma başarısızsa oturum yine açık kabul edilir.
      }
      return {
        installed: true,
        version,
        signedIn: true,
        accountEmail,
      };
    } catch {
      return {
        installed: true,
        version,
        signedIn: false,
        error: '1Password CLI oturumu açık değil (terminalde `op signin` çalıştırın).',
      };
    }
  }

  async resolveReference(reference: string, account?: string): Promise<string> {
    const cleanRef = reference.trim();
    if (!isOpReference(cleanRef)) {
      throw new Error('Geçerli bir op:// referansı değil.');
    }
    const cleanAccount = account?.trim() ?? '';
    const cacheKey = `${cleanAccount}::${cleanRef}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const args = ['read', '--no-newline', cleanRef];
    if (cleanAccount) {
      args.push('--account', cleanAccount);
    }
    const { stdout } = await this.runOp(args);
    const resolved = stdout;
    this.cache.set(cacheKey, {
      value: resolved,
      expiresAt: now + CACHE_TTL_MS,
    });
    return resolved;
  }

  async resolvePreview(
    reference: string,
    account?: string
  ): Promise<{ ok: boolean; maskedPreview?: string; error?: string }> {
    if (!isOpReference(reference)) {
      return { ok: false, error: 'Referans `op://vault/item/field` biçiminde olmalıdır.' };
    }
    try {
      const value = await this.resolveReference(reference, account);
      return {
        ok: true,
        maskedPreview: maskSecretPreview(value),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resolveEnvSecrets(
    env: Record<string, string>,
    opts: {
      enabled: boolean;
      account?: string;
      warn?: (message: string, context?: Record<string, unknown>) => void;
    }
  ): Promise<Record<string, string>> {
    if (!opts.enabled) return env;
    const entries = Object.entries(env);
    if (!entries.some(([, val]) => isOpReference(val))) {
      return env;
    }

    const result: Record<string, string> = { ...env };
    for (const [key, val] of entries) {
      if (!isOpReference(val)) continue;
      try {
        result[key] = await this.resolveReference(val, opts.account);
      } catch (error) {
        // Gizli değer ASLA loglanmaz; yalnızca env anahtar adı ve referans yolu yazılır.
        opts.warn?.('1Password secret referansı çözümlenemedi', {
          envKey: key,
          reference: val.trim(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }
}

export const sharedOnePasswordResolver = new OnePasswordResolver();
