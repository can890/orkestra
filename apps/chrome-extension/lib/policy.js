// Orkestra Chrome uzantısının saf (DOM'suz, chrome API'siz) politika mantığı. Hem service
// worker hem de masaüstü testleri bu modülü doğrudan içe aktarır; derleme adımı yoktur.

/** Masaüstü köprüsüyle konuşulan protokol sürümü ve WebSocket alt protokol adı. */
export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = 'orkestra-chrome.v1';
export const TOKEN_SUBPROTOCOL_PREFIX = 'token.';
export const DEFAULT_PORT = 47653;

/** Masaüstünün isteyebileceği 18 eylem; başka hiçbir eylem yürütülmez. */
export const ACTIONS = [
  'tabs_list',
  'tab_create',
  'tab_close',
  'tab_select',
  'navigate',
  'read_page',
  'find',
  'get_page_text',
  'click',
  'type',
  'form_input',
  'press_key',
  'scroll',
  'screenshot',
  'evaluate',
  'wait_for',
  'console',
  'network',
];

export const MAX_TEXT_CHARS = 200_000;
export const MAX_TYPE_CHARS = 10_000;
export const MAX_URL_LENGTH = 2048;
export const MAX_EVAL_CHARS = 50_000;

const BLOCKED_HOSTS = new Set(['chromewebstore.google.com']);

/**
 * Ajanın işlem yapabileceği bir sayfa adresi mi? Yalnızca http/https; Chrome iç sayfaları
 * (`chrome://`, `devtools://`, `chrome-extension://`, `about:`), `file://`, Chrome Web Mağazası
 * ve kimlik bilgisi içeren adresler dışarıda kalır.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedPageUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
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
 * Kaynak kalıbı (`https://örnek.com/*`); desteklenmeyen adreste null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function originPattern(value) {
  if (!isSupportedPageUrl(value)) return null;
  const url = new URL(/** @type {string} */ (value));
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * `<all_urls>` ile tüm desteklenen http/https sayfaları izinlidir. Geriye dönük uyumluluk için
 * özel bir `grantedOrigins` dizisi verilirse onu da değerlendirir.
 * @param {unknown} url
 * @param {readonly string[]} [grantedOrigins]
 * @returns {boolean}
 */
export function isUrlPermitted(url, grantedOrigins) {
  const pattern = originPattern(url);
  if (pattern === null) return false;
  if (!Array.isArray(grantedOrigins)) return true;
  if (grantedOrigins.includes('<all_urls>') || grantedOrigins.includes('*://*/*')) return true;
  if (grantedOrigins.includes(pattern)) return true;
  const scheme = pattern.startsWith('https:') ? 'https' : 'http';
  return grantedOrigins.includes(`${scheme}://*/*`);
}

const CARD_NAME_PATTERN =
  /card.?(number|num|no)\b|\bcc.?(num|number|csc|cvc|cvv|exp)|\bcvv\b|\bcvc\b|security.?code/i;

/**
 * Yazma/okuma yapılmaması gereken alan mı? Şifre alanları ve ödeme kartı alanları.
 * @param {{ tag?: string, type?: string, autocomplete?: string, name?: string, id?: string } | null | undefined} field
 * @returns {boolean}
 */
export function isForbiddenField(field) {
  if (!field) return false;
  const type = String(field.type ?? '').toLowerCase();
  if (type === 'password') return true;
  if (CARD_NAME_PATTERN.test(`${field.name ?? ''} ${field.id ?? ''}`)) return true;
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
 * `tabId ?? tab_id ?? tab` parametresini esnek biçimde çözümler.
 * @param {Record<string, unknown>} params
 * @param {boolean} required
 * @returns {{ ok: true, out: Record<string, unknown> } | { ok: false, reason: string }}
 */
function extractTabId(params, required) {
  const raw = params.tabId ?? params.tab_id ?? params.tab;
  if (raw === undefined) {
    if (required) return { ok: false, reason: 'invalid_tab' };
    return { ok: true, out: {} };
  }
  if (!isTabId(raw)) return { ok: false, reason: 'invalid_tab' };
  return {
    ok: true,
    out: {
      tabId: raw,
      ...(params.tab !== undefined ? { tab: raw } : {}),
    },
  };
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

    case 'tab_create': {
      if (!isSupportedPageUrl(params.url)) return { ok: false, reason: 'invalid_url' };
      if (params.active !== undefined && typeof params.active !== 'boolean') {
        return { ok: false, reason: 'invalid_active' };
      }
      return {
        ok: true,
        params: {
          url: params.url,
          ...(params.active === undefined ? {} : { active: params.active }),
        },
      };
    }

    case 'tab_close': {
      const tab = extractTabId(params, true);
      if (!tab.ok) return tab;
      return { ok: true, params: { ...tab.out } };
    }

    case 'tab_select': {
      const tab = extractTabId(params, true);
      if (!tab.ok) return tab;
      return { ok: true, params: { ...tab.out } };
    }

    case 'navigate': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const navAction = params.action ?? 'goto';
      if (
        typeof navAction !== 'string' ||
        !['goto', 'back', 'forward', 'reload'].includes(navAction)
      ) {
        return { ok: false, reason: 'invalid_navigate_action' };
      }
      if (navAction === 'goto') {
        if (!isSupportedPageUrl(params.url)) return { ok: false, reason: 'invalid_url' };
      } else if (params.url !== undefined && !isSupportedPageUrl(params.url)) {
        return { ok: false, reason: 'invalid_url' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          action: navAction,
          ...(params.url === undefined ? {} : { url: params.url }),
        },
      };
    }

    case 'read_page': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const filter = params.filter;
      if (filter !== undefined && filter !== 'interactive' && filter !== 'all') {
        return { ok: false, reason: 'invalid_filter' };
      }
      const rootRef = params.rootRef ?? params.root_ref;
      if (rootRef !== undefined && !isElementRef(rootRef)) {
        return { ok: false, reason: 'invalid_ref' };
      }
      const maxElements = params.maxElements ?? params.max_elements;
      if (
        maxElements !== undefined &&
        !(Number.isSafeInteger(maxElements) && maxElements >= 1 && maxElements <= 5000)
      ) {
        return { ok: false, reason: 'invalid_max_elements' };
      }
      const maxChars = params.maxChars ?? params.max_chars;
      if (
        maxChars !== undefined &&
        !(Number.isSafeInteger(maxChars) && maxChars >= 1 && maxChars <= MAX_TEXT_CHARS)
      ) {
        return { ok: false, reason: 'invalid_max_chars' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(filter === undefined ? {} : { filter }),
          ...(rootRef === undefined ? {} : { rootRef }),
          ...(maxElements === undefined ? {} : { maxElements }),
          ...(maxChars === undefined ? {} : { maxChars }),
        },
      };
    }

    case 'find': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { query, selector, role, limit } = params;
      if (query !== undefined && (typeof query !== 'string' || query.length > 1000)) {
        return { ok: false, reason: 'invalid_query' };
      }
      if (
        selector !== undefined &&
        (typeof selector !== 'string' || selector.trim().length === 0 || selector.length > 1000)
      ) {
        return { ok: false, reason: 'invalid_selector' };
      }
      if (
        role !== undefined &&
        (typeof role !== 'string' || role.trim().length === 0 || role.length > 100)
      ) {
        return { ok: false, reason: 'invalid_role' };
      }
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500)) {
        return { ok: false, reason: 'invalid_limit' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(query === undefined ? {} : { query }),
          ...(selector === undefined ? {} : { selector }),
          ...(role === undefined ? {} : { role }),
          ...(limit === undefined ? {} : { limit }),
        },
      };
    }

    case 'get_page_text': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { selector, ref } = params;
      if (
        selector !== undefined &&
        (typeof selector !== 'string' || selector.trim().length === 0 || selector.length > 1000)
      ) {
        return { ok: false, reason: 'invalid_selector' };
      }
      if (ref !== undefined && !isElementRef(ref)) {
        return { ok: false, reason: 'invalid_ref' };
      }
      const maxChars = params.maxChars ?? params.max_chars;
      if (
        maxChars !== undefined &&
        !(Number.isSafeInteger(maxChars) && maxChars >= 1 && maxChars <= MAX_TEXT_CHARS)
      ) {
        return { ok: false, reason: 'invalid_max_chars' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(selector === undefined ? {} : { selector }),
          ...(ref === undefined ? {} : { ref }),
          ...(maxChars === undefined ? {} : { maxChars }),
        },
      };
    }

    case 'click': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { ref, selector, x, y, button, double } = params;
      if (ref !== undefined && !isElementRef(ref)) return { ok: false, reason: 'invalid_ref' };
      if (
        selector !== undefined &&
        (typeof selector !== 'string' || selector.trim().length === 0 || selector.length > 1000)
      ) {
        return { ok: false, reason: 'invalid_selector' };
      }
      if (
        (x !== undefined || y !== undefined) &&
        !(
          typeof x === 'number' &&
          Number.isFinite(x) &&
          typeof y === 'number' &&
          Number.isFinite(y)
        )
      ) {
        return { ok: false, reason: 'invalid_coordinates' };
      }
      if (ref === undefined && selector === undefined && x === undefined) {
        return { ok: false, reason: 'invalid_ref' };
      }
      if (
        button !== undefined &&
        (typeof button !== 'string' || !['left', 'right', 'middle'].includes(button))
      ) {
        return { ok: false, reason: 'invalid_button' };
      }
      if (double !== undefined && typeof double !== 'boolean') {
        return { ok: false, reason: 'invalid_double' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(ref === undefined ? {} : { ref }),
          ...(selector === undefined ? {} : { selector }),
          ...(x === undefined ? {} : { x, y }),
          ...(button === undefined ? {} : { button }),
          ...(double === undefined ? {} : { double }),
        },
      };
    }

    case 'type': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      if (!isElementRef(params.ref)) return { ok: false, reason: 'invalid_ref' };
      if (typeof params.text !== 'string' || params.text.length > MAX_TYPE_CHARS) {
        return { ok: false, reason: 'invalid_text' };
      }
      if (params.clear !== undefined && typeof params.clear !== 'boolean') {
        return { ok: false, reason: 'invalid_clear' };
      }
      if (params.submit !== undefined && typeof params.submit !== 'boolean') {
        return { ok: false, reason: 'invalid_submit' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ref: params.ref,
          text: params.text,
          ...(params.clear === undefined ? {} : { clear: params.clear }),
          ...(params.submit === undefined ? {} : { submit: params.submit }),
        },
      };
    }

    case 'form_input': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      if (!isElementRef(params.ref)) return { ok: false, reason: 'invalid_ref' };
      const val = params.value;
      const validVal =
        (typeof val === 'string' && val.length <= MAX_TYPE_CHARS) ||
        typeof val === 'boolean' ||
        (typeof val === 'number' && Number.isFinite(val));
      if (!validVal) return { ok: false, reason: 'invalid_value' };
      return {
        ok: true,
        params: {
          ...tab.out,
          ref: params.ref,
          value: val,
        },
      };
    }

    case 'press_key': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      if (
        typeof params.key !== 'string' ||
        params.key.trim().length === 0 ||
        params.key.length > 64
      ) {
        return { ok: false, reason: 'invalid_key' };
      }
      if (params.ref !== undefined && !isElementRef(params.ref)) {
        return { ok: false, reason: 'invalid_ref' };
      }
      if (
        params.modifiers !== undefined &&
        (!Array.isArray(params.modifiers) ||
          params.modifiers.length > 8 ||
          !params.modifiers.every((m) => typeof m === 'string' && m.length <= 32))
      ) {
        return { ok: false, reason: 'invalid_modifiers' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          key: params.key,
          ...(params.ref === undefined ? {} : { ref: params.ref }),
          ...(params.modifiers === undefined ? {} : { modifiers: params.modifiers }),
        },
      };
    }

    case 'scroll': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { direction, amount, ref } = params;
      const toRef = params.toRef ?? params.to_ref;
      if (
        direction !== undefined &&
        (typeof direction !== 'string' || !['up', 'down', 'left', 'right'].includes(direction))
      ) {
        return { ok: false, reason: 'invalid_direction' };
      }
      if (
        amount !== undefined &&
        !(typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount <= 100_000)
      ) {
        return { ok: false, reason: 'invalid_amount' };
      }
      if (ref !== undefined && !isElementRef(ref)) return { ok: false, reason: 'invalid_ref' };
      if (toRef !== undefined && !isElementRef(toRef)) return { ok: false, reason: 'invalid_ref' };
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(direction === undefined ? {} : { direction }),
          ...(amount === undefined ? {} : { amount }),
          ...(ref === undefined ? {} : { ref }),
          ...(toRef === undefined ? {} : { toRef }),
        },
      };
    }

    case 'screenshot': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { format, quality } = params;
      if (format !== undefined && format !== 'png' && format !== 'jpeg') {
        return { ok: false, reason: 'invalid_format' };
      }
      if (
        quality !== undefined &&
        !(Number.isSafeInteger(quality) && quality >= 1 && quality <= 100)
      ) {
        return { ok: false, reason: 'invalid_quality' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(format === undefined ? {} : { format }),
          ...(quality === undefined ? {} : { quality }),
        },
      };
    }

    case 'evaluate': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      if (
        typeof params.expression !== 'string' ||
        params.expression.trim().length === 0 ||
        params.expression.length > MAX_EVAL_CHARS
      ) {
        return { ok: false, reason: 'invalid_expression' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          expression: params.expression,
        },
      };
    }

    case 'wait_for': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const text = params.text;
      const textGone = params.textGone ?? params.text_gone;
      const selector = params.selector;
      const selectorGone = params.selectorGone ?? params.selector_gone;
      const seconds = params.seconds;
      const timeoutMs = params.timeoutMs ?? params.timeout_ms;
      if (text !== undefined && (typeof text !== 'string' || text.length === 0 || text.length > 2000)) {
        return { ok: false, reason: 'invalid_text' };
      }
      if (
        textGone !== undefined &&
        (typeof textGone !== 'string' || textGone.length === 0 || textGone.length > 2000)
      ) {
        return { ok: false, reason: 'invalid_text_gone' };
      }
      if (
        selector !== undefined &&
        (typeof selector !== 'string' || selector.trim().length === 0 || selector.length > 1000)
      ) {
        return { ok: false, reason: 'invalid_selector' };
      }
      if (
        selectorGone !== undefined &&
        (typeof selectorGone !== 'string' ||
          selectorGone.trim().length === 0 ||
          selectorGone.length > 1000)
      ) {
        return { ok: false, reason: 'invalid_selector_gone' };
      }
      if (
        seconds !== undefined &&
        !(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 60)
      ) {
        return { ok: false, reason: 'invalid_seconds' };
      }
      if (
        timeoutMs !== undefined &&
        !(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60_000)
      ) {
        return { ok: false, reason: 'invalid_timeout' };
      }
      if (
        text === undefined &&
        textGone === undefined &&
        selector === undefined &&
        selectorGone === undefined &&
        seconds === undefined
      ) {
        return { ok: false, reason: 'invalid_wait_condition' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(text === undefined ? {} : { text }),
          ...(textGone === undefined ? {} : { textGone }),
          ...(selector === undefined ? {} : { selector }),
          ...(selectorGone === undefined ? {} : { selectorGone }),
          ...(seconds === undefined ? {} : { seconds }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      };
    }

    case 'console': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const { level, limit, clear } = params;
      if (
        level !== undefined &&
        (typeof level !== 'string' || !['all', 'log', 'info', 'warn', 'error'].includes(level))
      ) {
        return { ok: false, reason: 'invalid_level' };
      }
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000)) {
        return { ok: false, reason: 'invalid_limit' };
      }
      if (clear !== undefined && typeof clear !== 'boolean') {
        return { ok: false, reason: 'invalid_clear' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(level === undefined ? {} : { level }),
          ...(limit === undefined ? {} : { limit }),
          ...(clear === undefined ? {} : { clear }),
        },
      };
    }

    case 'network': {
      const tab = extractTabId(params, false);
      if (!tab.ok) return tab;
      const urlFilter = params.urlFilter ?? params.url_filter;
      const { method, status, limit, clear } = params;
      if (urlFilter !== undefined && (typeof urlFilter !== 'string' || urlFilter.length > 1000)) {
        return { ok: false, reason: 'invalid_url_filter' };
      }
      if (
        method !== undefined &&
        (typeof method !== 'string' || method.trim().length === 0 || method.length > 32)
      ) {
        return { ok: false, reason: 'invalid_method' };
      }
      if (status !== undefined && !(Number.isSafeInteger(status) && status >= 0 && status <= 599)) {
        return { ok: false, reason: 'invalid_status' };
      }
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000)) {
        return { ok: false, reason: 'invalid_limit' };
      }
      if (clear !== undefined && typeof clear !== 'boolean') {
        return { ok: false, reason: 'invalid_clear' };
      }
      return {
        ok: true,
        params: {
          ...tab.out,
          ...(urlFilter === undefined ? {} : { urlFilter }),
          ...(method === undefined ? {} : { method }),
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
          ...(clear === undefined ? {} : { clear }),
        },
      };
    }

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
 * Sıfır sürtünme: token zorunluluğu yoktur; varsayılan port (47653) üzerinden doğrudan
 * `['orkestra-chrome.v1']` ile bağlanır. Eğer geçerli 64-hex token verilmişse alt protokollere
 * `'token.' + token` de eklenir.
 * @param {{ token?: unknown, port?: unknown }} [settings]
 * @returns {{ url: string, protocols: string[] } | null}
 */
export function buildConnection(settings = {}) {
  const port = Number(settings?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const token = typeof settings?.token === 'string' ? settings.token.trim().toLowerCase() : '';
  const protocols = /^[0-9a-f]{64}$/.test(token)
    ? [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${token}`]
    : [SUBPROTOCOL];
  return {
    url: `ws://127.0.0.1:${port}/`,
    protocols,
  };
}
