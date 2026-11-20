// Orkestra Chrome köprüsü: MV3 service worker. Masaüstü uygulamasıyla 127.0.0.1 üzerinde
// sıfır sürtünmeyle WebSocket kurar, gelen 18 eylemi doğrular ve yalnızca http/https sekmelerde
// yürütür (`chrome://`, `file://`, `devtools://`, `chrome-extension://`, Web Store engellidir).

import { hideAgentOverlay, showAgentOverlay } from './lib/agent-overlay.js';
import { createConnectionManager } from './lib/connection.js';
import {
  checkWaitCondition,
  clickRef,
  evaluateInPage,
  findInPage,
  formInputRef,
  getPageText,
  pressKeyInPage,
  readConsolePage,
  readNetworkPage,
  scrollPage,
  snapshotPage,
  typeRef,
} from './lib/page-functions.js';
import {
  DEFAULT_PORT,
  ERROR_CODES,
  buildConnection,
  isSupportedPageUrl,
  parseServerMessage,
} from './lib/policy.js';

const RECONNECT_ALARM = 'orkestra-reconnect';
const NAVIGATION_TIMEOUT_MS = 20_000;
const BADGE_CLEAR_MS = 4_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const WAIT_POLL_INTERVAL_MS = 150;
const MAX_ACTIVITY_ENTRIES = 12;

const ACTION_LABELS = {
  tabs_list: 'Sekmeler listelendi',
  tab_create: 'Yeni sekme açıldı',
  tab_close: 'Sekme kapatıldı',
  tab_select: 'Sekmeye geçildi',
  navigate: 'Sayfaya gidildi',
  read_page: 'Sayfa okundu',
  find: 'Öğe arandı',
  get_page_text: 'Sayfa metni okundu',
  click: 'Tıklandı',
  type: 'Metin yazıldı',
  form_input: 'Form güncellendi',
  press_key: 'Tuşa basıldı',
  scroll: 'Sayfa kaydırıldı',
  screenshot: 'Ekran görüntüsü alındı',
  evaluate: 'Komut çalıştırıldı',
  wait_for: 'Sayfa beklendi',
  console: 'Konsol okundu',
  network: 'Ağ trafiği okundu',
};

const ACTIVE_LABELS = {
  navigate: 'Sayfaya gidiliyor',
  read_page: 'Sayfa okunuyor',
  find: 'Öğe aranıyor',
  get_page_text: 'Metin okunuyor',
  click: 'Tıklanıyor',
  type: 'Yazılıyor',
  form_input: 'Form dolduruluyor',
  press_key: 'Tuş gönderiliyor',
  scroll: 'Kaydırılıyor',
  screenshot: 'Ekran görüntüsü',
  evaluate: 'Çalıştırılıyor',
  wait_for: 'Bekleniyor',
  console: 'Konsol okunuyor',
  network: 'Ağ izleniyor',
};

/** @type {Array<{ id: string, action: string, label: string, host: string, tabId: number | null, ok: boolean, at: number }>} */
const recentActivity = [];
/** @type {{ action: string, label: string, at: number } | null} */
let activeAction = null;

/** @param {unknown} url */
function hostFromUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {string} id
 * @param {string} action
 * @param {Record<string, any> | undefined} result
 * @param {boolean} ok
 */
function recordActivity(id, action, result, ok) {
  const host = hostFromUrl(result?.url) || (action === 'tabs_list' ? 'Chrome' : '');
  const tabId = typeof result?.tabId === 'number' ? result.tabId : typeof result?.id === 'number' ? result.id : null;
  recentActivity.unshift({
    id,
    action,
    label: ACTION_LABELS[action] ?? action,
    host,
    tabId,
    ok,
    at: Date.now(),
  });
  if (recentActivity.length > MAX_ACTIVITY_ENTRIES) {
    recentActivity.length = MAX_ACTIVITY_ENTRIES;
  }
}

export class BridgeFailure extends Error {
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

export const bridge = createConnectionManager({
  readSettings: async () => {
    const settings = await readSettings();
    return { enabled: settings.enabled, connection: buildConnection(settings) };
  },
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  onMessage: (ws, data) => void onMessage(ws, data),
});

/** @param {WebSocket} ws @param {unknown} raw */
export async function onMessage(ws, raw) {
  const parsed = parseServerMessage(raw);
  if (!parsed.ok) return;
  if (parsed.kind === 'ping') {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (parsed.kind !== 'request') return;
  const { id, action, params } = parsed.request;
  activeAction = { action, label: ACTIVE_LABELS[action] ?? ACTION_LABELS[action] ?? action, at: Date.now() };
  let reply;
  try {
    const result = await handle(action, params);
    recordActivity(id, action, /** @type {Record<string, any>} */ (result), true);
    reply = { type: 'response', id, ok: true, result };
  } catch (error) {
    recordActivity(id, action, undefined, false);
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
  } finally {
    activeAction = null;
  }
  if (ws.readyState === 1) ws.send(JSON.stringify(reply));
}

/** @param {number} tabId */
async function getTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('Missing tab');
    }
    return tab;
  } catch {
    throw new BridgeFailure(ERROR_CODES.noSuchTab, `There is no tab with id ${tabId}.`);
  }
}

/**
 * `tabId` verilmişse o sekmeyi, verilmemişse aktif penceredeki aktif sekmeyi bulur.
 * @param {number | undefined} tabId
 */
async function resolveTab(tabId) {
  if (typeof tabId === 'number') {
    return getTab(tabId);
  }
  const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const candidate =
    focusedTabs.find((t) => typeof t.id === 'number' && isSupportedPageUrl(t.url)) ??
    focusedTabs.find((t) => typeof t.id === 'number');
  if (candidate && typeof candidate.id === 'number') return candidate;

  const anyActive = await chrome.tabs.query({ active: true });
  const fallback =
    anyActive.find((t) => typeof t.id === 'number' && isSupportedPageUrl(t.url)) ??
    anyActive.find((t) => typeof t.id === 'number');
  if (fallback && typeof fallback.id === 'number') return fallback;

  throw new BridgeFailure(ERROR_CODES.noSuchTab, 'No active tab was found.');
}

/**
 * Sekmenin güncel adresinin desteklenen bir http/https sayfası olduğunu doğrular.
 * `chrome://`, `file://`, `devtools://`, `chrome-extension://`, `about:` ve Chrome Web Store
 * adresleri kesin olarak reddedilir.
 * @param {number | undefined} tabId
 */
async function requireSupportedTab(tabId) {
  const tab = await resolveTab(tabId);
  const url = tab.url ?? '';
  if (!isSupportedPageUrl(url)) {
    throw new BridgeFailure(
      ERROR_CODES.unsupportedPage,
      'This page cannot be controlled by the agent (only http and https pages are supported).'
    );
  }
  return tab;
}

/** @param {string} url */
function requireSupportedTarget(url) {
  if (!isSupportedPageUrl(url)) {
    throw new BridgeFailure(
      ERROR_CODES.unsupportedPage,
      'Only http and https pages can be opened.'
    );
  }
}

const timers = new Map();
/** Ajan bir sekmede çalışırken görünür rozet ve sayfa içi Orkestra çerçevesi gösterir. @param {number} tabId @param {string} [actionName] */
function markActive(tabId, actionName) {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#008f5a' }).catch(() => {});
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
  if (actionName && actionName !== 'screenshot' && chrome.scripting?.executeScript) {
    const label = ACTIVE_LABELS[actionName] ?? 'Kontrol ediliyor';
    void chrome.scripting
      .executeScript({ target: { tabId }, func: showAgentOverlay, args: [label, BADGE_CLEAR_MS] })
      .catch(() => {});
  }
}

/** @param {boolean} enabled */
function syncGlobalBadge(enabled) {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  if (!enabled) {
    void chrome.action.setBadgeBackgroundColor({ color: '#52525b' }).catch(() => {});
    void chrome.action.setBadgeText({ text: '⏸' }).catch(() => {});
    void chrome.action.setTitle({ title: 'Orkestra duraklatıldı' }).catch(() => {});
  } else {
    void chrome.action.setBadgeText({ text: '' }).catch(() => {});
    void chrome.action.setTitle({ title: 'Orkestra' }).catch(() => {});
  }
}

/**
 * @param {number} tabId
 * @param {number} [timeoutMs]
 */
function waitForLoad(tabId, timeoutMs = NAVIGATION_TIMEOUT_MS) {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(undefined);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} action
 * @param {Record<string, any>} params
 */
export async function handle(action, params = {}) {
  const targetTabId = params.tabId ?? params.tab_id ?? params.tab;

  switch (action) {
    case 'tabs_list': {
      const allTabs = await chrome.tabs.query({});
      const tabs = allTabs.map((tab) => {
        const url = typeof tab.url === 'string' ? tab.url : '';
        const supported = isSupportedPageUrl(url);
        return {
          id: tab.id,
          tabId: tab.id,
          windowId: tab.windowId,
          active: tab.active === true,
          title: supported ? (tab.title ?? '') : '',
          url: supported ? url : '',
          supported,
          permitted: supported,
          ...(tab.pinned !== undefined ? { pinned: Boolean(tab.pinned) } : {}),
          ...(tab.audible !== undefined ? { audible: Boolean(tab.audible) } : {}),
        };
      });
      return { tabs };
    }

    case 'tab_create': {
      requireSupportedTarget(params.url);
      const active = params.active !== undefined ? Boolean(params.active) : true;
      const tab = await chrome.tabs.create({ url: params.url, active });
      markActive(tab.id);
      await waitForLoad(tab.id);
      const after = await getTab(tab.id).catch(() => tab);
      return {
        id: tab.id,
        tabId: tab.id,
        windowId: after.windowId ?? tab.windowId,
        url: isSupportedPageUrl(after.url) ? after.url : params.url,
        title: after.title ?? '',
        active: after.active ?? active,
      };
    }

    case 'tab_close': {
      const tab = await getTab(targetTabId);
      await chrome.tabs.remove(tab.id);
      return { closed: true, tabId: tab.id, id: tab.id };
    }

    case 'tab_select': {
      const tab = await getTab(targetTabId);
      const updated = (await chrome.tabs.update(tab.id, { active: true })) ?? tab;
      if (typeof updated.windowId === 'number' && chrome.windows?.update) {
        await chrome.windows.update(updated.windowId, { focused: true }).catch(() => {});
      }
      markActive(tab.id);
      const currentUrl = updated.url ?? tab.url ?? '';
      return {
        id: tab.id,
        tabId: tab.id,
        windowId: updated.windowId ?? tab.windowId,
        url: isSupportedPageUrl(currentUrl) ? currentUrl : '',
        title: isSupportedPageUrl(currentUrl) ? (updated.title ?? tab.title ?? '') : '',
        active: true,
      };
    }

    case 'navigate': {
      const navAction = params.action ?? 'goto';
      if (navAction === 'goto') {
        requireSupportedTarget(params.url);
      }

      let tab;
      if (typeof targetTabId === 'number') {
        tab = await getTab(targetTabId);
      } else {
        try {
          tab = await resolveTab(undefined);
        } catch (error) {
          if (navAction === 'goto') {
            const created = await chrome.tabs.create({ url: params.url, active: true });
            markActive(created.id, 'navigate');
            await waitForLoad(created.id);
            const afterNew = await getTab(created.id).catch(() => created);
            const afterNewUrl = afterNew.url ?? params.url ?? '';
            return {
              id: created.id,
              tabId: created.id,
              url: isSupportedPageUrl(afterNewUrl) ? afterNewUrl : '',
              title: isSupportedPageUrl(afterNewUrl) ? (afterNew.title ?? '') : '',
            };
          }
          throw error;
        }
      }

      const current = tab.url ?? '';
      const blank =
        current === '' ||
        current === 'about:blank' ||
        current.startsWith('chrome://newtab') ||
        current.startsWith('chrome://new-tab-page');

      if (navAction === 'goto') {
        if (!blank && !isSupportedPageUrl(current)) {
          // Açıkça sekme kimliği verilmediyse (ör. kullanıcı chrome://extensions sayfasındaysa)
          // hata vermek yerine doğrudan yeni sekme aç.
          if (typeof targetTabId !== 'number') {
            const created = await chrome.tabs.create({ url: params.url, active: true });
            markActive(created.id, 'navigate');
            await waitForLoad(created.id);
            const afterNew = await getTab(created.id).catch(() => created);
            const afterNewUrl = afterNew.url ?? params.url ?? '';
            return {
              id: created.id,
              tabId: created.id,
              url: isSupportedPageUrl(afterNewUrl) ? afterNewUrl : '',
              title: isSupportedPageUrl(afterNewUrl) ? (afterNew.title ?? '') : '',
            };
          }
          throw new BridgeFailure(
            ERROR_CODES.unsupportedPage,
            'This kind of page cannot be used by the agent.'
          );
        }
        markActive(tab.id, 'navigate');
        await chrome.tabs.update(tab.id, { url: params.url });
        await waitForLoad(tab.id);
      } else {
        if (!isSupportedPageUrl(current)) {
          throw new BridgeFailure(
            ERROR_CODES.unsupportedPage,
            'This kind of page cannot be used by the agent.'
          );
        }
        markActive(tab.id, 'navigate');
        if (navAction === 'back') {
          if (typeof chrome.tabs.goBack === 'function') await chrome.tabs.goBack(tab.id);
          else await inject(tab.id, () => history.back(), []);
          await waitForLoad(tab.id, 1_500);
        } else if (navAction === 'forward') {
          if (typeof chrome.tabs.goForward === 'function') await chrome.tabs.goForward(tab.id);
          else await inject(tab.id, () => history.forward(), []);
          await waitForLoad(tab.id, 1_500);
        } else if (navAction === 'reload') {
          if (typeof chrome.tabs.reload === 'function') await chrome.tabs.reload(tab.id);
          else await inject(tab.id, () => location.reload(), []);
          await waitForLoad(tab.id);
        }
      }

      const after = await getTab(tab.id);
      const afterUrl = after.url ?? params.url ?? '';
      return {
        id: tab.id,
        tabId: tab.id,
        url: isSupportedPageUrl(afterUrl) ? afterUrl : '',
        title: isSupportedPageUrl(afterUrl) ? (after.title ?? '') : '',
      };
    }

    case 'read_page': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'read_page');
      const snapshot = await inject(tab.id, snapshotPage, [
        {
          maxChars: params.maxChars ?? params.max_chars ?? 20_000,
          filter: params.filter ?? 'interactive',
          rootRef: params.rootRef ?? params.root_ref,
          maxElements: params.maxElements ?? params.max_elements ?? 400,
        },
      ]);
      if (!snapshot) {
        throw new BridgeFailure(ERROR_CODES.failed, 'The page did not answer.');
      }
      if (snapshot.ok === false) {
        throw new BridgeFailure(
          snapshot.code ?? ERROR_CODES.failed,
          snapshot.message ?? messageFor(snapshot.code)
        );
      }
      if (!isSupportedPageUrl(snapshot.url)) {
        throw new BridgeFailure(
          ERROR_CODES.unsupportedPage,
          'This kind of page cannot be used by the agent.'
        );
      }
      return {
        tabId: tab.id,
        url: snapshot.url,
        title: snapshot.title,
        elements: snapshot.elements,
        tree: snapshot.tree,
        pageText: snapshot.pageText ?? snapshot.text,
        text: snapshot.text,
        truncated: snapshot.truncated,
      };
    }

    case 'find': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'find');
      const res = unwrapPageResult(
        await inject(tab.id, findInPage, [
          {
            query: params.query,
            selector: params.selector,
            role: params.role,
            limit: params.limit ?? 25,
          },
        ])
      );
      return {
        tabId: tab.id,
        url: res.url,
        title: res.title,
        matches: res.matches,
      };
    }

    case 'get_page_text': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'get_page_text');
      const res = unwrapPageResult(
        await inject(tab.id, getPageText, [
          {
            selector: params.selector,
            ref: params.ref,
            maxChars: params.maxChars ?? params.max_chars ?? 50_000,
          },
        ])
      );
      return {
        tabId: tab.id,
        url: res.url,
        title: res.title,
        text: res.text,
        truncated: res.truncated,
      };
    }

    case 'click': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'click');
      const res = unwrapPageResult(
        await inject(tab.id, clickRef, [
          {
            ref: params.ref,
            selector: params.selector,
            x: params.x,
            y: params.y,
            button: params.button ?? 'left',
            double: params.double === true,
          },
        ])
      );
      return {
        ok: true,
        clicked: true,
        tabId: tab.id,
        ...(res.ref ? { ref: res.ref } : {}),
        ...(res.tag ? { tag: res.tag } : {}),
        ...(res.text !== undefined ? { text: res.text } : {}),
        ...(res.x !== undefined ? { x: res.x } : {}),
        ...(res.y !== undefined ? { y: res.y } : {}),
      };
    }

    case 'type': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'type');
      const res = unwrapPageResult(
        await inject(tab.id, typeRef, [
          {
            ref: params.ref,
            text: params.text,
            clear: params.clear !== false,
            submit: params.submit === true,
          },
        ])
      );
      return {
        ok: true,
        typed: true,
        tabId: tab.id,
        ref: params.ref,
        ...(res.value !== undefined ? { value: res.value } : {}),
      };
    }

    case 'form_input': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'form_input');
      const res = unwrapPageResult(
        await inject(tab.id, formInputRef, [{ ref: params.ref, value: params.value }])
      );
      return {
        ok: true,
        updated: true,
        tabId: tab.id,
        ref: params.ref,
        tag: res.tag,
        value: res.value,
      };
    }

    case 'press_key': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'press_key');
      const res = unwrapPageResult(
        await inject(tab.id, pressKeyInPage, [
          {
            key: params.key,
            ref: params.ref,
            modifiers: params.modifiers,
          },
        ])
      );
      return {
        ok: true,
        pressed: true,
        tabId: tab.id,
        key: res.key ?? params.key,
      };
    }

    case 'scroll': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'scroll');
      const res = unwrapPageResult(
        await inject(tab.id, scrollPage, [
          {
            direction: params.direction ?? 'down',
            amount: params.amount ?? 500,
            ref: params.ref,
            toRef: params.toRef ?? params.to_ref,
          },
        ])
      );
      return {
        ok: true,
        scrolled: true,
        tabId: tab.id,
        scrollX: res.scrollX,
        scrollY: res.scrollY,
      };
    }

    case 'screenshot': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'screenshot');
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
      }
      if (chrome.scripting?.executeScript) {
        await chrome.scripting
          .executeScript({ target: { tabId: tab.id }, func: hideAgentOverlay })
          .catch(() => {});
      }
      const format = params.format === 'png' ? 'png' : 'jpeg';
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const captureOpts =
        format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: params.quality ?? 70 };
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOpts);
      } catch (error) {
        throw new BridgeFailure(
          ERROR_CODES.failed,
          `Could not capture screenshot: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
      const data = comma === -1 ? '' : dataUrl.slice(comma + 1);
      if (!data || data.length > MAX_SCREENSHOT_BYTES) {
        throw new BridgeFailure(ERROR_CODES.failed, 'The screenshot is empty or too large.');
      }
      return {
        tabId: tab.id,
        mimeType,
        data,
        dataUrl,
      };
    }

    case 'evaluate': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id, 'evaluate');
      const res = unwrapPageResult(
        await inject(tab.id, evaluateInPage, [params.expression], 'MAIN')
      );
      return {
        tabId: tab.id,
        result: res.result,
        type: res.type,
      };
    }

    case 'wait_for': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id);
      const startedAt = Date.now();
      const text = params.text;
      const textGone = params.textGone ?? params.text_gone;
      const selector = params.selector;
      const selectorGone = params.selectorGone ?? params.selector_gone;
      const seconds = params.seconds;
      const timeoutMs = params.timeoutMs ?? params.timeout_ms ?? 10_000;

      if (typeof seconds === 'number' && seconds > 0) {
        await sleep(Math.min(seconds * 1000, 60_000));
      }

      const hasDomCondition =
        text !== undefined ||
        textGone !== undefined ||
        selector !== undefined ||
        selectorGone !== undefined;

      if (hasDomCondition) {
        for (;;) {
          const check = unwrapPageResult(
            await inject(tab.id, checkWaitCondition, [
              { text, textGone, selector, selectorGone },
            ])
          );
          if (check.matched === true) break;
          if (Date.now() - startedAt >= timeoutMs) {
            throw new BridgeFailure(
              ERROR_CODES.failed,
              'Timed out waiting for the requested condition.'
            );
          }
          await sleep(WAIT_POLL_INTERVAL_MS);
        }
      }

      return {
        matched: true,
        tabId: tab.id,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    }

    case 'console': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id);
      const res = unwrapPageResult(
        await inject(
          tab.id,
          readConsolePage,
          [
            {
              level: params.level ?? 'all',
              limit: params.limit ?? 100,
              clear: params.clear === true,
            },
          ],
          'MAIN'
        )
      );
      return {
        tabId: tab.id,
        entries: res.entries,
      };
    }

    case 'network': {
      const tab = await requireSupportedTab(targetTabId);
      markActive(tab.id);
      const res = unwrapPageResult(
        await inject(
          tab.id,
          readNetworkPage,
          [
            {
              urlFilter: params.urlFilter ?? params.url_filter,
              method: params.method,
              status: params.status,
              limit: params.limit ?? 100,
              clear: params.clear === true,
            },
          ],
          'MAIN'
        )
      );
      return {
        tabId: tab.id,
        requests: res.requests,
      };
    }

    default:
      throw new BridgeFailure(ERROR_CODES.failed, 'Unknown action.');
  }
}

/**
 * Sayfaya sabit bir fonksiyon enjekte eder.
 * @param {number} tabId
 * @param {(...args: any[]) => any} func
 * @param {any[]} args
 * @param {'ISOLATED' | 'MAIN'} [world]
 */
async function inject(tabId, func, args, world) {
  try {
    const [first] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      ...(world ? { world } : {}),
    });
    return first?.result;
  } catch (error) {
    throw new BridgeFailure(
      ERROR_CODES.failed,
      `The page could not be accessed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** @param {Record<string, any> | undefined} result */
function unwrapPageResult(result) {
  if (!result) throw new BridgeFailure(ERROR_CODES.failed, 'The page did not answer.');
  if (result.ok === true) return result;
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

export function initBackground() {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;

  async function buildPopupStatus() {
    const settings = await readSettings();
    const port =
      Number.isInteger(settings.port) && settings.port >= 1024 && settings.port <= 65535
        ? settings.port
        : DEFAULT_PORT;
    let activeTab = null;
    let controllableTabCount = 0;
    try {
      const allTabs = await chrome.tabs.query({});
      controllableTabCount = allTabs.filter((t) => isSupportedPageUrl(t.url)).length;
      const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const current = focused[0];
      if (current) {
        const supported = isSupportedPageUrl(current.url);
        activeTab = {
          id: current.id ?? null,
          supported,
          host: supported ? hostFromUrl(current.url) : '',
          title: supported ? (current.title ?? '') : '',
        };
      }
    } catch {
      // Sekme bilgisi alınamazsa yalnızca köprü durumu döner.
    }
    return {
      ...bridge.status(),
      enabled: settings.enabled,
      port,
      hasToken: buildConnection(settings) !== null,
      activeAction,
      recentActivity: recentActivity.slice(0, 6),
      activeTab,
      controllableTabCount,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    void (async () => {
      if (message.type === 'reconnect') {
        await chrome.storage.local.set({ enabled: true });
        syncGlobalBadge(true);
        bridge.disconnect();
        await bridge.connect();
      } else if (message.type === 'disconnect') {
        await chrome.storage.local.set({ enabled: false });
        syncGlobalBadge(false);
        bridge.disconnect();
      } else if (message.type === 'reload') {
        bridge.disconnect();
        await bridge.connect();
      } else if (message.type === 'set_port') {
        const nextPort = Number(message.port);
        if (Number.isInteger(nextPort) && nextPort >= 1024 && nextPort <= 65535) {
          await chrome.storage.local.set({ port: nextPort, enabled: true });
          syncGlobalBadge(true);
          bridge.disconnect();
          await bridge.connect();
        }
      } else if (message.type === 'clear_activity') {
        recentActivity.length = 0;
      } else if (message.type === 'focus_tab' && typeof message.tabId === 'number') {
        try {
          const tab = await chrome.tabs.update(message.tabId, { active: true });
          if (tab && typeof tab.windowId === 'number' && chrome.windows?.update) {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
        } catch {
          // Sekme kapanmış olabilir.
        }
      }
      sendResponse(await buildPopupStatus());
    })();
    return true;
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && (changes.token || changes.port || changes.enabled)) {
      if (changes.enabled) syncGlobalBadge(changes.enabled.newValue !== false);
      bridge.disconnect();
      void bridge.connect();
    }
  });

  chrome.alarms?.create?.(RECONNECT_ALARM, { periodInMinutes: 0.4 });
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) void bridge.connect();
  });
  chrome.runtime.onStartup?.addListener(() => void bridge.connect());
  chrome.runtime.onInstalled?.addListener(() => void bridge.connect());
  chrome.tabs?.onActivated?.addListener(() => void bridge.connect());
  chrome.tabs?.onUpdated?.addListener((_tabId, info) => {
    if (info && info.status === 'complete') void bridge.connect();
  });
  chrome.windows?.onFocusChanged?.addListener(() => void bridge.connect());

  void readSettings().then((s) => syncGlobalBadge(s.enabled));
  void bridge.connect();
}

initBackground();
