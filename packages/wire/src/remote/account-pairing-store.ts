import {
  ACCOUNT_PAIRING_DESCRIPTION,
  ACCOUNT_PAIRING_FILE,
  emptyAccountPairingDocument,
  parseAccountPairingDocument,
  serializeAccountPairingDocument,
  type AccountPairingDocument,
} from './account-pairing';

/**
 * Buluşma belgesinin GitHub'daki deposu: hesabın gizli (listelenmeyen) bir gist'i. Masaüstü ve
 * telefon aynı kodu kullanır; yalnızca `fetch` ve erişim belirteci dışarıdan verilir. Belirteç hiçbir
 * hata iletisine, günlüğe ya da dönüş değerine girmez.
 */

export type AccountPairingStoreErrorCode =
  /** Belirteç geçersiz ya da süresi dolmuş (401). */
  | 'unauthorized'
  /** Belirtecin `gist` izni yok. */
  | 'missing-scope'
  | 'rate-limited'
  /** Ağ hatası ya da GitHub 5xx. */
  | 'network'
  /** Beklenmeyen yanıt biçimi. */
  | 'invalid-response'
  /** Yazma, eşzamanlı başka bir yazmayla defalarca çakıştı. */
  | 'conflict';

export class AccountPairingStoreError extends Error {
  constructor(readonly code: AccountPairingStoreErrorCode) {
    super(`Account pairing store failed: ${code}`);
    this.name = 'AccountPairingStoreError';
  }
}

export type AccountPairingHttpResponse = {
  status: number;
  /** Başlık adları küçük harfle sorulur. */
  header(name: string): string | null;
  text(): Promise<string>;
};

export type AccountPairingHttp = (request: {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<AccountPairingHttpResponse>;

export type AccountPairingStoreOptions = {
  /** Geçerli GitHub erişim belirteci. */
  getToken: () => string | Promise<string>;
  http?: AccountPairingHttp;
  /** GitHub Enterprise için; varsayılan `https://api.github.com`. */
  apiBaseUrl?: string;
};

export type AccountPairingRead =
  | { status: 'ok'; document: AccountPairingDocument; etag: string | null }
  /** `etag` verildi ve belge değişmedi (GitHub bu yanıtı hız sınırına saymaz). */
  | { status: 'not-modified' }
  /** Gist silinmiş ya da içinde belge dosyası yok. */
  | { status: 'missing' };

export type AccountPairingStore = {
  /** Hesaptaki buluşma gist'inin kimliği; yoksa `null`. */
  find(): Promise<string | null>;
  read(gistId: string, etag?: string | null): Promise<AccountPairingRead>;
  /**
   * Oku → `change` uygula → yaz → yeniden oku → `verify`. `verify` tutmazsa (eşzamanlı başka bir
   * yazma değişikliği ezdiyse) birkaç kez yeniden dener. Gist yoksa ve `create` verilmişse oluşturur.
   */
  update(input: {
    gistId: string | null;
    change: (document: AccountPairingDocument) => AccountPairingDocument;
    verify: (document: AccountPairingDocument) => boolean;
    create?: boolean;
  }): Promise<{ gistId: string; document: AccountPairingDocument; etag: string | null } | null>;
};

const DEFAULT_API = 'https://api.github.com';
const MAX_UPDATE_ATTEMPTS = 4;
const LIST_PAGES = 3;
const GIST_ID = /^[0-9a-f]{8,64}$/;

/** Tarayıcıda, Node'da ve WebView'de bulunan `fetch` üzerine ince sarmalayıcı. */
export const fetchAccountPairingHttp: AccountPairingHttp = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    cache: 'no-store',
  });
  return {
    status: response.status,
    header: (name) => response.headers.get(name),
    text: () => response.text(),
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAccountPairingStore(
  options: AccountPairingStoreOptions
): AccountPairingStore {
  const http = options.http ?? fetchAccountPairingHttp;
  const api = (options.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, '');

  async function call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    extra: { body?: unknown; etag?: string | null } = {}
  ): Promise<AccountPairingHttpResponse> {
    const token = await options.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (extra.body !== undefined) headers['Content-Type'] = 'application/json';
    if (extra.etag) headers['If-None-Match'] = extra.etag;
    let response: AccountPairingHttpResponse;
    try {
      response = await http({
        method,
        url: `${api}${path}`,
        headers,
        ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
      });
    } catch {
      // Özgün hata URL ya da başlık taşıyabilir; yalnızca kod iletilir.
      throw new AccountPairingStoreError('network');
    }
    if (response.status === 401) throw new AccountPairingStoreError('unauthorized');
    if (response.status === 429) throw new AccountPairingStoreError('rate-limited');
    if (response.status === 403) {
      throw new AccountPairingStoreError(
        response.header('x-ratelimit-remaining') === '0' ? 'rate-limited' : 'missing-scope'
      );
    }
    if (response.status >= 500) throw new AccountPairingStoreError('network');
    // Klasik belirteçlerde GitHub verilen izinleri bu başlıkta bildirir; yoksa denetlenemez.
    const scopes = response.header('x-oauth-scopes');
    if (scopes !== null && !scopes.split(',').some((scope) => scope.trim() === 'gist')) {
      throw new AccountPairingStoreError('missing-scope');
    }
    return response;
  }

  async function json(response: AccountPairingHttpResponse): Promise<unknown> {
    try {
      return JSON.parse(await response.text());
    } catch {
      throw new AccountPairingStoreError('invalid-response');
    }
  }

  /** Bir gist yanıtından belgeyi çıkarır; dosya yoksa `null`. */
  function documentOf(gist: unknown): AccountPairingDocument | null {
    if (!isRecord(gist) || !isRecord(gist.files)) return null;
    const file = gist.files[ACCOUNT_PAIRING_FILE];
    if (!isRecord(file) || file.truncated === true) return null;
    // Bozuk içerik boş belge sayılır; bir sonraki yazma onu düzeltir.
    return parseAccountPairingDocument(file.content) ?? emptyAccountPairingDocument();
  }

  async function find(): Promise<string | null> {
    for (let page = 1; page <= LIST_PAGES; page += 1) {
      const response = await call('GET', `/gists?per_page=100&page=${page}`);
      if (response.status !== 200) throw new AccountPairingStoreError('invalid-response');
      const list = await json(response);
      if (!Array.isArray(list)) throw new AccountPairingStoreError('invalid-response');
      for (const gist of list) {
        if (!isRecord(gist) || !isRecord(gist.files)) continue;
        if (ACCOUNT_PAIRING_FILE in gist.files && typeof gist.id === 'string') {
          if (GIST_ID.test(gist.id)) return gist.id;
        }
      }
      if (list.length < 100) break;
    }
    return null;
  }

  async function read(gistId: string, etag?: string | null): Promise<AccountPairingRead> {
    if (!GIST_ID.test(gistId)) return { status: 'missing' };
    const response = await call('GET', `/gists/${gistId}`, { etag: etag ?? null });
    if (response.status === 304) return { status: 'not-modified' };
    if (response.status === 404) return { status: 'missing' };
    if (response.status !== 200) throw new AccountPairingStoreError('invalid-response');
    const document = documentOf(await json(response));
    if (!document) return { status: 'missing' };
    return { status: 'ok', document, etag: response.header('etag') };
  }

  async function create(document: AccountPairingDocument): Promise<string> {
    const response = await call('POST', '/gists', {
      body: {
        description: ACCOUNT_PAIRING_DESCRIPTION,
        public: false,
        files: { [ACCOUNT_PAIRING_FILE]: { content: serializeAccountPairingDocument(document) } },
      },
    });
    // `gist` izni olmayan belirteçlerde GitHub 404 döner.
    if (response.status === 404) throw new AccountPairingStoreError('missing-scope');
    if (response.status !== 201) throw new AccountPairingStoreError('invalid-response');
    const gist = await json(response);
    if (!isRecord(gist) || typeof gist.id !== 'string' || !GIST_ID.test(gist.id)) {
      throw new AccountPairingStoreError('invalid-response');
    }
    return gist.id;
  }

  async function write(gistId: string, document: AccountPairingDocument): Promise<boolean> {
    const response = await call('PATCH', `/gists/${gistId}`, {
      body: {
        files: { [ACCOUNT_PAIRING_FILE]: { content: serializeAccountPairingDocument(document) } },
      },
    });
    if (response.status === 404) return false;
    if (response.status !== 200) throw new AccountPairingStoreError('invalid-response');
    return true;
  }

  const update: AccountPairingStore['update'] = async (input) => {
    let gistId = input.gistId;
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      let current: AccountPairingDocument | null = null;
      if (gistId) {
        const existing = await read(gistId);
        if (existing.status === 'ok') current = existing.document;
        else gistId = null;
      }
      if (!gistId) {
        gistId = await find();
        if (gistId) continue;
        if (!input.create) return null;
        gistId = await create(input.change(emptyAccountPairingDocument()));
      } else if (!(await write(gistId, input.change(current ?? emptyAccountPairingDocument())))) {
        gistId = null;
        continue;
      }
      const after = await read(gistId);
      if (after.status === 'ok' && input.verify(after.document)) {
        return { gistId, document: after.document, etag: after.etag };
      }
    }
    throw new AccountPairingStoreError('conflict');
  };

  return { find, read, update };
}

/**
 * Testler için bellekte çalışan GitHub gist sunucusu (masaüstü ve telefon testleri aynısını
 * kullanır). `http` alanı `createAccountPairingStore`a verilir. Belirteç → hesap eşlemesi `tokens`
 * ile kurulur; `scopes` verilmezse belirteç `gist` iznine sahiptir.
 */
export function createMemoryGistServer(
  tokens: Record<string, { account: string; scopes?: string[] }>
) {
  type Gist = { id: string; owner: string; files: Record<string, string>; version: number };
  const gists = new Map<string, Gist>();
  const log: { method: string; path: string; status: number }[] = [];
  let counter = 0;

  const reply = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): AccountPairingHttpResponse => ({
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const shape = (gist: Gist) => ({
    id: gist.id,
    public: false,
    files: Object.fromEntries(
      Object.entries(gist.files).map(([name, content]) => [name, { filename: name, content }])
    ),
  });

  const http: AccountPairingHttp = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const bearer = /^Bearer (.+)$/.exec(request.headers.Authorization ?? '')?.[1] ?? '';
    const identity = tokens[bearer];
    const finish = (response: AccountPairingHttpResponse) => {
      log.push({ method: request.method, path, status: response.status });
      return response;
    };
    if (!identity) return finish(reply(401, { message: 'Bad credentials' }));
    const scopes = identity.scopes ?? ['gist'];
    const headers = { 'x-oauth-scopes': scopes.join(', ') };
    const body = request.body === undefined ? null : (JSON.parse(request.body) as unknown);
    const filesOf = (value: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!isRecord(value) || !isRecord(value.files)) return out;
      for (const [name, file] of Object.entries(value.files)) {
        if (isRecord(file) && typeof file.content === 'string') out[name] = file.content;
      }
      return out;
    };

    if (path === '/gists' && request.method === 'GET') {
      const mine = [...gists.values()].filter((gist) => gist.owner === identity.account);
      return finish(reply(200, mine.map(shape), headers));
    }
    if (path === '/gists' && request.method === 'POST') {
      if (!scopes.includes('gist')) return finish(reply(404, { message: 'Not Found' }, headers));
      counter += 1;
      const gist: Gist = {
        id: counter.toString(16).padStart(32, '0'),
        owner: identity.account,
        files: filesOf(body),
        version: 1,
      };
      gists.set(gist.id, gist);
      return finish(reply(201, shape(gist), headers));
    }
    const match = /^\/gists\/([0-9a-f]+)$/.exec(path);
    const gist = match ? gists.get(match[1]!) : undefined;
    if (!match || !gist) return finish(reply(404, { message: 'Not Found' }, headers));
    const etag = `"${gist.id}-${gist.version}"`;
    if (request.method === 'GET') {
      // Gizli gist'ler adresini bilen herkesçe okunabilir; sahiplik yalnızca yazmada aranır.
      if (request.headers['If-None-Match'] === etag) return finish(reply(304, undefined, headers));
      return finish(reply(200, shape(gist), { ...headers, etag }));
    }
    if (request.method === 'PATCH') {
      if (gist.owner !== identity.account || !scopes.includes('gist')) {
        return finish(reply(404, { message: 'Not Found' }, headers));
      }
      Object.assign(gist.files, filesOf(body));
      gist.version += 1;
      return finish(reply(200, shape(gist), headers));
    }
    return finish(reply(404, { message: 'Not Found' }, headers));
  };

  return {
    http,
    /** Yapılan istekler (belirteç içermez). */
    log,
    /** Bir hesabın belge içeriği; yoksa `null`. */
    contentOf(account: string): string | null {
      for (const gist of gists.values()) {
        if (gist.owner === account && ACCOUNT_PAIRING_FILE in gist.files) {
          return gist.files[ACCOUNT_PAIRING_FILE]!;
        }
      }
      return null;
    },
    /** Belgeyi sunucu tarafında doğrudan değiştirir (başka bir cihazın yazması gibi). */
    overwrite(account: string, content: string): void {
      for (const gist of gists.values()) {
        if (gist.owner === account && ACCOUNT_PAIRING_FILE in gist.files) {
          gist.files[ACCOUNT_PAIRING_FILE] = content;
          gist.version += 1;
        }
      }
    },
    deleteAll(): void {
      gists.clear();
    },
  };
}
