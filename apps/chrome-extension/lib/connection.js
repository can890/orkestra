// Orkestra Chrome köprüsü: masaüstüne giden tek WebSocket bağlantısının yaşam döngüsü.
// chrome API'si kullanmaz; soket ve ayar okuma dışarıdan verilir, böylece Node'da test edilir.
//
// Neden ayrı bir modül: service worker aynı anda birkaç yerden bağlanmayı dener (ilk yükleme,
// alarm, ayar değişikliği, sekme/pencere etkinliği, açılır pencere). Bu denemeler birbirini
// beklemezse iki soket açılır. Burada bağlanma tek sıraya sokulur ve bağlantı koptuğunda
// `enabled !== false` olduğu sürece 1000, 2000, 5000 ms kademeli aralıklarla kesintisiz
// yeniden bağlanmayı dener.

/** Beklenmedik kopuştan sonraki kademeli yeniden deneme aralıkları (son değerle sürekli devam eder). */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000];
/** Yeni soketi açmadan önce eskisinin kapanması için beklenen en uzun süre. */
export const CLOSE_WAIT_MS = 1_500;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export const CONNECT_ERROR =
  'Masaüstü uygulamasına bağlanılamadı (kapalı, yanlış belirteç ya da köprü devre dışı).';
export const TOKEN_ERROR = 'Eşleştirme belirteci eksik ya da geçersiz.';

/**
 * @param {{
 *   readSettings: () => Promise<{ enabled: boolean, connection: { url: string, protocols: string[] } | null }>,
 *   createSocket: (url: string, protocols: string[]) => any,
 *   onMessage: (socket: any, data: unknown) => void,
 * }} deps
 */
export function createConnectionManager(deps) {
  /** @type {any} */
  let socket = null;
  /** @type {'disconnected' | 'connecting' | 'connected'} */
  let state = 'disconnected';
  let lastError = '';
  /** Yürüyen bağlanma denemesi; aynı anda yalnızca bir tane olur. @type {Promise<void> | null} */
  let opening = null;
  /** Kapanmakta olan eski soket. @type {Promise<void> | null} */
  let closing = null;
  /** Her `disconnect` çağrısında artar; yürüyen deneme eski ayarla soket açmasın diye. */
  let generation = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  let retries = 0;

  /** @param {any} ws */
  const isLive = (ws) => ws !== null && (ws.readyState === OPEN || ws.readyState === CONNECTING);

  function cancelRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (retryTimer !== null) return;
    const index = Math.min(retries, RETRY_DELAYS_MS.length - 1);
    const delay = RETRY_DELAYS_MS[index] ?? 5_000;
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  async function open() {
    let settings;
    let seen;
    for (;;) {
      seen = generation;
      if (closing) await closing;
      settings = await deps.readSettings();
      if (seen === generation && !closing) break;
    }
    if (isLive(socket)) return;
    cancelRetry();
    if (settings.enabled === false) {
      retries = 0;
      state = 'disconnected';
      lastError = '';
      return;
    }
    if (!settings.connection) {
      retries = 0;
      state = 'disconnected';
      lastError = TOKEN_ERROR;
      return;
    }
    state = 'connecting';
    let current;
    try {
      current = deps.createSocket(settings.connection.url, settings.connection.protocols);
    } catch (error) {
      state = 'disconnected';
      lastError = String(error);
      if (seen === generation) scheduleRetry();
      return;
    }
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      state = 'connected';
      lastError = '';
      retries = 0;
      cancelRetry();
    };
    current.onmessage = (/** @type {{ data: unknown }} */ event) => {
      if (socket === current) deps.onMessage(current, event.data);
    };
    current.onerror = () => {
      if (socket === current) lastError = CONNECT_ERROR;
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      state = 'disconnected';
      scheduleRetry();
    };
  }

  /** Bağlı değilse bağlanır. Eşzamanlı çağrılar aynı denemeyi paylaşır. */
  function connect() {
    opening ??= open().finally(() => {
      opening = null;
    });
    return opening;
  }

  /** Bağlantıyı bırakır. Ardından gelen `connect`, eski soket kapanana kadar bekler. */
  function disconnect() {
    generation += 1;
    cancelRetry();
    retries = 0;
    const current = socket;
    socket = null;
    state = 'disconnected';
    if (!current || current.readyState === CLOSED) return;
    /** @type {Promise<void>} */
    const closed = new Promise((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      current.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    }).then(() => {
      if (closing === closed) closing = null;
    });
    closing = closed;
    try {
      current.close(1000, 'user disconnect');
    } catch {
      // Zaten kapanmış soket; bekleme zaman aşımıyla biter.
    }
  }

  return {
    connect,
    disconnect,
    status: () => ({ state, lastError }),
  };
}
