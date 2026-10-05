// OpenSSH known_hosts biçimini okur, sunucu anahtarlarını karşılaştırır ve onaylanan anahtarları
// Orkestra'nın kendi dosyasına yazar. Kullanıcının ~/.ssh dosyalarına hiçbir zaman yazılmaz.
import { createHash, createHmac } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type KnownHostEntry = {
  marker: 'cert-authority' | 'revoked' | null;
  /** Yazıldığı gibi host kalıpları: `ad`, `[ad]:port`, `*.ornek.com`, `!ad`, `|1|tuz|hash`. */
  hosts: string[];
  keyType: string;
  /** Anahtar verisinin base64 hâli (SSH kablo biçimi). */
  key: string;
};

export type HostKeyCheck =
  | { kind: 'match' }
  | { kind: 'revoked' }
  | { kind: 'changed'; knownFingerprints: string[]; files: string[] }
  | { kind: 'unknown'; knownKeyTypes: string[] };

export type KnownHostsSources = {
  /** Belirtilmezse varsayılan kullanıcı dosyaları (~/.ssh/known_hosts, known_hosts2). */
  userFiles?: string[];
  /** Belirtilmezse varsayılan sistem dosyaları (/etc/ssh/ssh_known_hosts, …2). */
  globalFiles?: string[];
};

export const DEFAULT_USER_KNOWN_HOSTS_FILES = ['~/.ssh/known_hosts', '~/.ssh/known_hosts2'];
export const DEFAULT_GLOBAL_KNOWN_HOSTS_FILES = [
  '/etc/ssh/ssh_known_hosts',
  '/etc/ssh/ssh_known_hosts2',
];

export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: KnownHostEntry['marker'] = null;
    if (fields[0]?.startsWith('@')) {
      const name = fields.shift()!.slice(1).toLowerCase();
      if (name !== 'cert-authority' && name !== 'revoked') continue;
      marker = name;
    }
    const [hosts, keyType, key] = fields;
    if (!hosts || !keyType || !key) continue;
    entries.push({ marker, hosts: hosts.split(','), keyType, key });
  }
  return entries;
}

/** known_hosts'ta hostun aranan adı: 22 numaralı portta yalnızca ad, diğerlerinde `[ad]:port`. */
export function knownHostName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function patternMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return digest === hash;
  }
  return globToRegExp(pattern).test(name);
}

/** Kalıplardan biri eşleşirse ve hiçbir `!` kalıbı eşleşmezse satır bu hosta aittir. */
export function entryMatchesHost(entry: KnownHostEntry, name: string): boolean {
  let matched = false;
  for (const raw of entry.hosts) {
    const negated = raw.startsWith('!');
    if (!patternMatches(negated ? raw.slice(1) : raw, name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** Anahtar verisinin başındaki tür adı (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, …). */
export function hostKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length <= 0 || length > 64 || 4 + length > blob.length) return null;
  return blob.subarray(4, 4 + length).toString('ascii');
}

/** OpenSSH'ın gösterdiği biçimde parmak izi: `SHA256:<base64, dolgusuz>`. */
export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function fingerprintOfBase64(key: string): string {
  return hostKeyFingerprint(Buffer.from(key, 'base64'));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export type KnownHostsStoreOptions = {
  /** Onaylanan anahtarların yazıldığı Orkestra dosyası. */
  ownFile: string;
  readFile?: (path: string) => Promise<string>;
  appendFile?: (path: string, data: string) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
};

export class KnownHostsStore {
  private readonly read: (path: string) => Promise<string>;
  private readonly append: (path: string, data: string) => Promise<void>;
  private readonly ensureDirectory: (path: string) => Promise<void>;

  constructor(private readonly options: KnownHostsStoreOptions) {
    this.read = options.readFile ?? ((path) => readFile(path, 'utf8'));
    this.append =
      options.appendFile ??
      ((path, data) => appendFile(path, data, { encoding: 'utf8', mode: 0o600 }));
    this.ensureDirectory =
      options.ensureDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      });
  }

  get ownFile(): string {
    return this.options.ownFile;
  }

  /** Hostun kayıtlı anahtar türleri; algoritma tercihi ve ilk bağlantı tespiti için. */
  async knownKeyTypes(name: string, sources: KnownHostsSources = {}): Promise<string[]> {
    const types = new Set<string>();
    for (const { entry } of await this.entriesFor(name, sources)) {
      if (entry.marker === null) types.add(entry.keyType);
    }
    return [...types];
  }

  async check(name: string, blob: Buffer, sources: KnownHostsSources = {}): Promise<HostKeyCheck> {
    const key = blob.toString('base64');
    const keyType = hostKeyType(blob);
    const matching = await this.entriesFor(name, sources);
    if (matching.some(({ entry }) => entry.marker === 'revoked' && entry.key === key)) {
      return { kind: 'revoked' };
    }
    const plain = matching.filter(({ entry }) => entry.marker === null);
    if (plain.some(({ entry }) => entry.key === key)) return { kind: 'match' };
    const sameType = plain.filter(({ entry }) => entry.keyType === keyType);
    if (sameType.length > 0) {
      return {
        kind: 'changed',
        knownFingerprints: [
          ...new Set(sameType.map(({ entry }) => fingerprintOfBase64(entry.key))),
        ],
        files: [...new Set(sameType.map(({ file }) => file))],
      };
    }
    return {
      kind: 'unknown',
      knownKeyTypes: [...new Set(plain.map(({ entry }) => entry.keyType))],
    };
  }

  async add(name: string, blob: Buffer): Promise<void> {
    const keyType = hostKeyType(blob);
    if (!keyType) throw new Error('Sunucu anahtarının türü okunamadı.');
    await this.ensureDirectory(dirname(this.options.ownFile));
    await this.append(this.options.ownFile, `${name} ${keyType} ${blob.toString('base64')}\n`);
  }

  private async entriesFor(
    name: string,
    sources: KnownHostsSources
  ): Promise<Array<{ entry: KnownHostEntry; file: string }>> {
    const files = [
      this.options.ownFile,
      ...(sources.userFiles ?? DEFAULT_USER_KNOWN_HOSTS_FILES),
      ...(sources.globalFiles ?? DEFAULT_GLOBAL_KNOWN_HOSTS_FILES),
    ].map(expandHome);
    const matches: Array<{ entry: KnownHostEntry; file: string }> = [];
    for (const file of [...new Set(files)]) {
      let content: string;
      try {
        content = await this.read(file);
      } catch {
        continue; // Olmayan ya da okunamayan dosyalar atlanır.
      }
      for (const entry of parseKnownHosts(content)) {
        if (entryMatchesHost(entry, name)) matches.push({ entry, file });
      }
    }
    return matches;
  }
}
