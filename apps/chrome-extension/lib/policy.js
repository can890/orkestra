// Orkestra Chrome uzantısının saf (DOM'suz, chrome API'siz) politika mantığı. Hem service
// worker hem de masaüstü testleri bu modülü doğrudan içe aktarır; derleme adımı yoktur.

/** Masaüstü köprüsüyle konuşulan protokol sürümü ve WebSocket alt protokol adı. */
export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = 'orkestra-chrome.v1';
export const TOKEN_SUBPROTOCOL_PREFIX = 'token.';
export const DEFAULT_PORT = 47653;

/** Masaüstünün isteyebileceği eylemler; başka hiçbir eylem yürütülmez. */
export const ACTIONS = ['tabs_list', 'tab_create', 'navigate', 'read_page', 'click', 'type', 'screenshot'];

export const MAX_TEXT_CHARS = 200_000;
export const MAX_TYPE_CHARS = 10_000;
export const MAX_URL_LENGTH = 2048;

const BLOCKED_HOSTS = new Set(['chromewebstore.google.com']);

/**
 * Ajanın işlem yapabileceği bir sayfa adresi mi? Yalnızca http/https; Chrome iç sayfaları,
 * uzantı sayfaları, file:, Chrome Web Mağazası ve kimlik bilgisi içeren adresler dışarıda kalır.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedPageUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (host === '') return false;
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host === 'chrome.google.com' && url.pathname.toLowerCase().startsWith('/webstore')) {
    return false;
  }
  return true;
}

/**
 * `chrome.permissions` için kaynak kalıbı (`https://örnek.com/*`); desteklenmeyen adreste null.
 * Bağlantı noktası yok sayılır: Chrome host izinlerinde bağlantı noktasını eşleştirmez.
 * @param {unknown} value
 * @returns {string | null}
 */
export function originPattern(value) {
  if (!isSupportedPageUrl(value)) return null;
  const url = new URL(/** @type {string} */ (value));
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Tarayıcının verdiği izinli kalıplar arasında bu adres var mı?
 * @param {unknown} url
 * @param {readonly string[]} grantedOrigins `chrome.permissions.getAll().origins`
 * @returns {boolean}
 */
export function isUrlPermitted(url, grantedOrigins) {
  const pattern = originPattern(url);
  if (pattern === null) return false;
  if (grantedOrigins.includes(pattern)) return true;
  const scheme = pattern.startsWith('https:') ? 'https' : 'http';
  return grantedOrigins.includes(`${scheme}://*/*`) || grantedOrigins.includes('*://*/*');
}

/**
 * Yazma/okuma yapılmaması gereken alan mı? Şifre alanları ve ödeme kartı alanları.
 * @param {{ tag?: string, type?: string, autocomplete?: string, inputMode?: string } | null | undefined} field
 * @returns {boolean}
 */
export function isForbiddenField(field) {
  if (!field) return false;
  const type = String(field.type ?? '').toLowerCase();
  if (type === 'password') return true;
  const tokens = String(field.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.some(
    (token) => token.startsWith('cc-') || token === 'current-password' || token === 'new-password'
  );
}

/**
 * @typedef {{ id: string, action: string, params: Record<string, unknown> }} BridgeRequest
 */

const REF_PATTERN = /^ref_[0-9]{1,6}$/;

/** @param {unknown} value */
export function isElementRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isTabId(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * Masaüstünden gelen bir WebSocket metnini doğrular. Geçersizse neden döner.
 * Başarılı sonuç yalnızca bilinen eylemleri ve doğrulanmış parametreleri taşır.
 * @param {unknown} raw
 * @returns {{ ok: true, kind: 'ping' } | { ok: true, kind: 'welcome' } | { ok: true, kind: 'request', request: BridgeRequest } | { ok: false, reason: string }}
 */
export function parseServerMessage(raw) {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return { ok: false, reason: 'too_large' };
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(message) || typeof message.type !== 'string') {
    return { ok: false, reason: 'invalid_shape' };
  }
  if (message.type === 'ping') return { ok: true, kind: 'ping' };
  if (message.type === 'welcome') return { ok: true, kind: 'welcome' };
  if (message.type !== 'request') return { ok: false, reason: 'unknown_type' };
  const { id, action } = message;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    return { ok: false, reason: 'unknown_action' };
  }
  const params = isRecord(message.params) ? message.params : {};
  const checked = validateParams(action, params);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, kind: 'request', request: { id, action, params: checked.params } };
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} params
 * @returns {{ ok: true, params: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function validateParams(action, params) {
  switch (action) {
    case 'tabs_list':
      return { ok: true, params: {} };
    case 'tab_create':
      if (!isSupportedPageUrl(params.url)) return { ok: false, reason: 'invalid_url' };
      return { ok: true, params: { url: params.url } };
    case 'navigate':
      if (!isTabId(params.tab)) return { ok: false, reason: 'invalid_tab' };
      if (!isSupportedPageUrl(params.url)) return { ok: false, reason: 'invalid_url' };
      return { ok: true, params: { tab: params.tab, url: params.url } };
    case 'read_page': {
      if (!isTabId(params.tab)) return { ok: false, reason: 'invalid_tab' };
      const max = params.maxChars;
      if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1 && max <= MAX_TEXT_CHARS)) {
        return { ok: false, reason: 'invalid_max_chars' };
      }
      return { ok: true, params: { tab: params.tab, ...(max === undefined ? {} : { maxChars: max }) } };
    }
    case 'click':
      if (!isTabId(params.tab)) return { ok: false, reason: 'invalid_tab' };
      if (!isElementRef(params.ref)) return { ok: false, reason: 'invalid_ref' };
      return { ok: true, params: { tab: params.tab, ref: params.ref } };
    case 'type':
      if (!isTabId(params.tab)) return { ok: false, reason: 'invalid_tab' };
      if (!isElementRef(params.ref)) return { ok: false, reason: 'invalid_ref' };
      if (typeof params.text !== 'string' || params.text.length > MAX_TYPE_CHARS) {
        return { ok: false, reason: 'invalid_text' };
      }
      if (params.submit !== undefined && typeof params.submit !== 'boolean') {
        return { ok: false, reason: 'invalid_submit' };
      }
      return {
        ok: true,
        params: {
          tab: params.tab,
          ref: params.ref,
          text: params.text,
          ...(params.submit === undefined ? {} : { submit: params.submit }),
        },
      };
    case 'screenshot':
      if (!isTabId(params.tab)) return { ok: false, reason: 'invalid_tab' };
      return { ok: true, params: { tab: params.tab } };
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}

/** Masaüstüne dönen hata kodları. */
export const ERROR_CODES = {
  siteNotPermitted: 'site_not_permitted',
  unsupportedPage: 'unsupported_page',
  forbiddenField: 'forbidden_field',
  noSuchTab: 'no_such_tab',
  noSuchElement: 'no_such_element',
  failed: 'failed',
};

/**
 * @param {string} origin Kullanıcıya gösterilecek kaynak (ör. https://örnek.com)
 */
export function siteNotPermittedMessage(origin) {
  return `The user must allow Orkestra on ${origin} in the Chrome extension (extension popup or options page) before the agent can use this site.`;
}

/**
 * Bağlantı ayarlarını doğrular ve WebSocket adresiyle alt protokolleri üretir.
 * @param {{ token?: unknown, port?: unknown }} settings
 * @returns {{ url: string, protocols: string[] } | null}
 */
export function buildConnection(settings) {
  const token = typeof settings.token === 'string' ? settings.token.trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const port = Number(settings.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return {
    url: `ws://127.0.0.1:${port}/`,
    protocols: [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`],
  };
}
