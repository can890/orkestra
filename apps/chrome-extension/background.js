// Orkestra Chrome köprüsü: service worker. Masaüstü uygulamasıyla 127.0.0.1 üzerinde WebSocket
// kurar, gelen istekleri doğrular ve yalnızca kullanıcının izin verdiği sitelerde yürütür.
// Rastgele betik çalıştırmaz: sayfaya yalnızca lib/page-functions.js içindeki sabit
// fonksiyonlar enjekte edilir.

import { createConnectionManager } from './lib/connection.js';
import { clickRef, snapshotPage, typeRef } from './lib/page-functions.js';
import {
  ERROR_CODES,
  buildConnection,
  isSupportedPageUrl,
  isUrlPermitted,
  parseServerMessage,
  siteNotPermittedMessage,
} from './lib/policy.js';

const RECONNECT_ALARM = 'orkestra-reconnect';
const NAVIGATION_TIMEOUT_MS = 20_000;
const BADGE_CLEAR_MS = 4_000;
const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
const SCREENSHOT_NEEDS_CLICK =
  'Chrome only allows a screenshot of a tab after the user has clicked the Orkestra extension icon on that tab. Use read_page instead, or ask the user to click the Orkestra icon on that tab and try again.';

class BridgeFailure extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function readSettings() {
  const stored = await chrome.storage.local.get(['token', 'port', 'enabled']);
  return { token: stored.token, port: stored.port, enabled: stored.enabled !== false };
}

// Bağlanma tek sıradan geçer (lib/connection.js); buradaki her çağrı aynı yöneticiyi kullanır.
const bridge = createConnectionManager({
  readSettings: async () => {
    const settings = await readSettings();
    return { enabled: settings.enabled, connection: buildConnection(settings) };
  },
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  onMessage: (ws, data) => void onMessage(ws, data),
});

/** @param {WebSocket} ws @param {unknown} raw */
async function onMessage(ws, raw) {
  const parsed = parseServerMessage(raw);
  if (!parsed.ok) return;
  if (parsed.kind === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (parsed.kind !== 'request') return;
  const { id, action, params } = parsed.request;
  let reply;
  try {
    const result = await handle(action, params);
    reply = { type: 'response', id, ok: true, result };
  } catch (error) {
    const failure =
      error instanceof BridgeFailure
        ? error
        : new BridgeFailure(
            ERROR_CODES.failed,
            error instanceof Error ? error.message : String(error)
          );
    reply = {
      type: 'response',
      id,
      ok: false,
      error: { code: failure.code, message: failure.message },
    };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

async function grantedOrigins() {
  const all = await chrome.permissions.getAll();
  return all.origins ?? [];
}

/** @param {number} tabId */
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new BridgeFailure(ERROR_CODES.noSuchTab, `There is no tab with id ${tabId}.`);
  }
}

/** Sekmenin güncel adresi desteklenen ve izinli bir site mi? */
async function requirePermittedTab(tabId) {
  const tab = await getTab(tabId);
  const url = tab.url ?? '';
  if (!url) {
    throw new BridgeFailure(
      ERROR_CODES.siteNotPermitted,
      "The user must allow Orkestra on this tab's site in the Chrome extension before the agent can use it."
    );
  }
  if (!isSupportedPageUrl(url)) {
    throw new BridgeFailure(
      ERROR_CODES.unsupportedPage,
      'This kind of page cannot be used by the agent.'
    );
  }
  if (!isUrlPermitted(url, await grantedOrigins())) {
    throw new BridgeFailure(ERROR_CODES.siteNotPermitted, siteNotPermittedMessage(originOf(url)));
  }
  return tab;
}

/** @param {string} url */
function originOf(url) {
  return new URL(url).origin;
}

/** @param {string} url */
async function requirePermittedTarget(url) {
  if (!isSupportedPageUrl(url)) {
    throw new BridgeFailure(
      ERROR_CODES.unsupportedPage,
      'Only http and https pages can be opened.'
    );
  }
  if (!isUrlPermitted(url, await grantedOrigins())) {
    throw new BridgeFailure(ERROR_CODES.siteNotPermitted, siteNotPermittedMessage(originOf(url)));
  }
}

const timers = new Map();
/** Ajan bir sekmede çalışırken görünür rozet gösterir. @param {number} tabId */
function markActive(tabId) {
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }).catch(() => {});
  void chrome.action.setBadgeText({ tabId, text: 'AI' }).catch(() => {});
  void chrome.action
    .setTitle({ tabId, title: 'Orkestra ajanı bu sekmede çalışıyor' })
    .catch(() => {});
  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => {
      timers.delete(tabId);
      void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      void chrome.action.setTitle({ tabId, title: 'Orkestra' }).catch(() => {});
    }, BADGE_CLEAR_MS)
  );
}

/** @param {number} tabId */
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(undefined);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, NAVIGATION_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** @param {string} action @param {Record<string, any>} params */
async function handle(action, params) {
  switch (action) {
    case 'tabs_list': {
      const origins = await grantedOrigins();
      const tabs = await chrome.tabs.query({});
      return tabs.map((tab) => {
        const permitted = typeof tab.url === 'string' && isUrlPermitted(tab.url, origins);
        return {
          id: tab.id,
          windowId: tab.windowId,
          active: tab.active === true,
          permitted,
          ...(permitted ? { url: tab.url, title: tab.title ?? '' } : {}),
        };
      });
    }
    case 'tab_create': {
      await requirePermittedTarget(params.url);
      const tab = await chrome.tabs.create({ url: params.url, active: false });
      markActive(tab.id);
      await waitForLoad(tab.id);
      return { id: tab.id, windowId: tab.windowId };
    }
    case 'navigate': {
      const tab = await getTab(params.tab);
      await requirePermittedTarget(params.url);
      const current = tab.url ?? '';
      const blank =
        current === '' || current === 'about:blank' || current.startsWith('chrome://newtab');
      if (!blank) await requirePermittedTab(params.tab);
      markActive(params.tab);
      await chrome.tabs.update(params.tab, { url: params.url });
      await waitForLoad(params.tab);
      const after = await getTab(params.tab);
      return {
        id: params.tab,
        url: isUrlPermitted(after.url, await grantedOrigins()) ? after.url : '',
      };
    }
    case 'read_page': {
      await requirePermittedTab(params.tab);
      markActive(params.tab);
      const snapshot = await inject(params.tab, snapshotPage, [params.maxChars ?? 20_000]);
      if (!isUrlPermitted(snapshot.url, await grantedOrigins())) {
        throw new BridgeFailure(
          ERROR_CODES.siteNotPermitted,
          siteNotPermittedMessage(originOf(snapshot.url))
        );
      }
      return snapshot;
    }
    case 'click':
      await requirePermittedTab(params.tab);
      markActive(params.tab);
      return actionResult(await inject(params.tab, clickRef, [params.ref]));
    case 'type':
      await requirePermittedTab(params.tab);
      markActive(params.tab);
      return actionResult(
        await inject(params.tab, typeRef, [params.ref, params.text, params.submit === true])
      );
    case 'screenshot': {
      const tab = await requirePermittedTab(params.tab);
      markActive(params.tab);
      await chrome.tabs.update(params.tab, { active: true });
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 70,
        });
      } catch {
        // Chrome, site izni olsa bile görünür sekmeyi yalnızca kullanıcının uzantıyı o sekmede
        // çağırmış olması (activeTab) hâlinde yakalatır.
        throw new BridgeFailure(ERROR_CODES.failed, SCREENSHOT_NEEDS_CLICK);
      }
      const comma = dataUrl.indexOf(',');
      const data = comma === -1 ? '' : dataUrl.slice(comma + 1);
      if (!data || data.length > MAX_SCREENSHOT_BYTES) {
        throw new BridgeFailure(ERROR_CODES.failed, 'The screenshot is empty or too large.');
      }
      return { mimeType: 'image/jpeg', data };
    }
    default:
      throw new BridgeFailure(ERROR_CODES.failed, 'Unknown action.');
  }
}

/** Yalnızca uzantıya gömülü sabit bir fonksiyonu çalıştırır; ajan verisi `args` ile gider. */
async function inject(tabId, func, args) {
  try {
    const [first] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return first?.result;
  } catch (error) {
    throw new BridgeFailure(
      ERROR_CODES.siteNotPermitted,
      `The page could not be accessed: ${String(error)}`
    );
  }
}

/** @param {{ ok: boolean, code?: string, message?: string } | undefined} result */
function actionResult(result) {
  if (!result) throw new BridgeFailure(ERROR_CODES.failed, 'The page did not answer.');
  if (result.ok) return { ok: true };
  throw new BridgeFailure(
    result.code ?? ERROR_CODES.failed,
    result.message ?? messageFor(result.code)
  );
}

/** @param {string | undefined} code */
function messageFor(code) {
  if (code === ERROR_CODES.forbiddenField) {
    return 'Typing into password and payment card fields is not allowed.';
  }
  if (code === ERROR_CODES.noSuchElement) {
    return 'The element is gone; call read_page again to get fresh refs.';
  }
  return 'The action failed.';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  void (async () => {
    if (message.type === 'reconnect') {
      await chrome.storage.local.set({ enabled: true });
      bridge.disconnect();
      await bridge.connect();
    } else if (message.type === 'disconnect') {
      await chrome.storage.local.set({ enabled: false });
      bridge.disconnect();
    } else if (message.type === 'reload') {
      bridge.disconnect();
      await bridge.connect();
    }
    const settings = await readSettings();
    sendResponse({
      ...bridge.status(),
      enabled: settings.enabled,
      hasToken: buildConnection(settings) !== null,
    });
  })();
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.port)) {
    bridge.disconnect();
    void bridge.connect();
  }
});
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void bridge.connect();
});
chrome.runtime.onStartup.addListener(() => void bridge.connect());
chrome.runtime.onInstalled.addListener(() => void bridge.connect());
void bridge.connect();
