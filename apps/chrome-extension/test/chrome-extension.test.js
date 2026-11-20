import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeFailure, handle, onMessage } from '../background.js';
import { hideAgentOverlay, showAgentOverlay } from '../lib/agent-overlay.js';
import {
  CLOSE_WAIT_MS,
  CONNECT_ERROR,
  RETRY_DELAYS_MS,
  createConnectionManager,
} from '../lib/connection.js';
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
} from '../lib/page-functions.js';
import '../lib/page-monitor.js';
import {
  ACTIONS,
  ERROR_CODES,
  buildConnection,
  isElementRef,
  isForbiddenField,
  isSupportedPageUrl,
  parseServerMessage,
  validateParams,
} from '../lib/policy.js';

const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const readExtFile = (name) => readFileSync(join(EXTENSION_DIR, name), 'utf8');

describe('1. Manifest, Popup ve Paket Bütünlüğü', () => {
  const manifest = JSON.parse(readExtFile('manifest.json'));

  it('MV3 manifest <all_urls> host_permissions, gerekli permissions ve MAIN world page-monitor içerir', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.permissions).toEqual(['tabs', 'scripting', 'storage', 'alarms']);
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['lib/page-monitor.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: false,
      },
    ]);
  });

  it('manifest atıf yaptığı tüm dosyalar mevcuttur', () => {
    const files = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.options_page,
      ...(manifest.content_scripts?.flatMap((cs) => cs.js) ?? []),
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
    ];
    for (const file of files) {
      expect(file).toBeTruthy();
      expect(existsSync(join(EXTENSION_DIR, file))).toBe(true);
    }
  });

  it.each([
    ['popup.js', 'popup.html'],
    ['options.js', 'options.html'],
  ])('%s içindeki tüm DOM kimlikleri %s içinde tanımlıdır', (script, page) => {
    const source = readExtFile(script);
    const ids = new Set();
    for (const match of source.matchAll(/(?:getElementById|\$)\(\s*['"]([\w-]+)['"]\s*\)/g)) {
      ids.add(match[1]);
    }
    expect(ids.size).toBeGreaterThan(0);
    const html = readExtFile(page);
    for (const id of ids) {
      expect(html).toMatch(new RegExp(`id=["']${id}["']`));
    }
    expect(html).toContain(`<script type="module" src="${script}"></script>`);
  });

  it('popup sadeleştirilmiştir; site izin listesi veya belirteç kalabalığı içermez', () => {
    const html = readExtFile('popup.html');
    expect(html).not.toContain('İzin verilen siteler');
    expect(html).not.toContain('Bu site');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="toggle"');
  });
});

describe('2. Politika, Güvenlik Sınırları ve Sıfır-Token Bağlantı (lib/policy.js)', () => {
  it('tam 18 eylemi tanımlar', () => {
    expect(ACTIONS).toEqual([
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
    ]);
    expect(ACTIONS).toHaveLength(18);
  });

  it('yalnızca http ve https URL adreslerine izin verir; chrome://, file://, devtools:// ve Web Store engellidir', () => {
    expect(isSupportedPageUrl('https://example.com/path?a=1')).toBe(true);
    expect(isSupportedPageUrl('http://localhost:3000/app')).toBe(true);

    for (const blocked of [
      'chrome://extensions',
      'chrome://settings',
      'file:///Users/selim/secret.txt',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://eojgjllnfmaghdadgmkchendjkbgbnoh/popup.html',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'https://chromewebstore.google.com/detail/abc',
      'https://chrome.google.com/webstore/detail/abc',
      'https://user:pass@example.com/',
      '',
      null,
      undefined,
    ]) {
      expect(isSupportedPageUrl(blocked)).toBe(false);
    }
  });

  it('token zorunluluğu olmadan doğrudan bağlantı üretir; opsiyonel geçerli token varsa ekler', () => {
    expect(buildConnection()).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1'],
    });
    expect(buildConnection({})).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1'],
    });
    expect(buildConnection({ port: 49000 })).toEqual({
      url: 'ws://127.0.0.1:49000/',
      protocols: ['orkestra-chrome.v1'],
    });

    const validToken = 'ab'.repeat(32);
    expect(buildConnection({ token: validToken, port: 47653 })).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1', `token.${validToken}`],
    });

    // Geçersiz port reddedilir
    expect(buildConnection({ port: 80 })).toBeNull();
    expect(buildConnection({ port: 70000 })).toBeNull();
  });

  it('18 eylemin tamamında hem camelCase hem snake_case parametreleri doğrular', () => {
    expect(validateParams('tabs_list', {})).toEqual({ ok: true, params: {} });
    expect(validateParams('tab_create', { url: 'https://example.com', active: false })).toEqual({
      ok: true,
      params: { url: 'https://example.com', active: false },
    });
    expect(validateParams('tab_close', { tab_id: 7 })).toEqual({
      ok: true,
      params: { tabId: 7 },
    });
    expect(validateParams('tab_select', { tabId: 3 })).toEqual({
      ok: true,
      params: { tabId: 3 },
    });
    expect(validateParams('navigate', { tab_id: 2, action: 'back' })).toEqual({
      ok: true,
      params: { tabId: 2, action: 'back' },
    });
    expect(
      validateParams('read_page', {
        tab_id: 5,
        filter: 'all',
        root_ref: 'ref_2',
        max_elements: 150,
        max_chars: 10000,
      })
    ).toEqual({
      ok: true,
      params: {
        tabId: 5,
        filter: 'all',
        rootRef: 'ref_2',
        maxElements: 150,
        maxChars: 10000,
      },
    });
    expect(
      validateParams('find', { tab_id: 1, query: 'Kaydet', role: 'button', limit: 10 })
    ).toEqual({
      ok: true,
      params: { tabId: 1, query: 'Kaydet', role: 'button', limit: 10 },
    });
    expect(
      validateParams('get_page_text', { tab_id: 1, selector: 'main', max_chars: 5000 })
    ).toEqual({
      ok: true,
      params: { tabId: 1, selector: 'main', maxChars: 5000 },
    });
    expect(
      validateParams('click', { tabId: 1, x: 100, y: 200, button: 'right', double: true })
    ).toEqual({
      ok: true,
      params: { tabId: 1, x: 100, y: 200, button: 'right', double: true },
    });
    expect(
      validateParams('type', {
        tab_id: 1,
        ref: 'ref_1',
        text: 'merhaba',
        clear: false,
        submit: true,
      })
    ).toEqual({
      ok: true,
      params: { tabId: 1, ref: 'ref_1', text: 'merhaba', clear: false, submit: true },
    });
    expect(validateParams('form_input', { tab_id: 1, ref: 'ref_3', value: true })).toEqual({
      ok: true,
      params: { tabId: 1, ref: 'ref_3', value: true },
    });
    expect(
      validateParams('press_key', { tab_id: 1, key: 'Enter', ref: 'ref_1', modifiers: ['Meta'] })
    ).toEqual({
      ok: true,
      params: { tabId: 1, key: 'Enter', ref: 'ref_1', modifiers: ['Meta'] },
    });
    expect(
      validateParams('scroll', { tab_id: 1, direction: 'down', amount: 400, to_ref: 'ref_8' })
    ).toEqual({
      ok: true,
      params: { tabId: 1, direction: 'down', amount: 400, toRef: 'ref_8' },
    });
    expect(validateParams('screenshot', { tab_id: 1, format: 'png', quality: 80 })).toEqual({
      ok: true,
      params: { tabId: 1, format: 'png', quality: 80 },
    });
    expect(validateParams('evaluate', { tab_id: 1, expression: 'document.title' })).toEqual({
      ok: true,
      params: { tabId: 1, expression: 'document.title' },
    });
    expect(
      validateParams('wait_for', {
        tab_id: 1,
        text: 'Yüklendi',
        text_gone: 'Yükleniyor',
        selector: '#app',
        selector_gone: '.spinner',
        timeout_ms: 5000,
      })
    ).toEqual({
      ok: true,
      params: {
        tabId: 1,
        text: 'Yüklendi',
        textGone: 'Yükleniyor',
        selector: '#app',
        selectorGone: '.spinner',
        timeoutMs: 5000,
      },
    });
    expect(validateParams('console', { tab_id: 1, level: 'error', limit: 50, clear: true })).toEqual(
      {
        ok: true,
        params: { tabId: 1, level: 'error', limit: 50, clear: true },
      }
    );
    expect(
      validateParams('network', {
        tab_id: 1,
        url_filter: '/api/',
        method: 'POST',
        status: 200,
        limit: 30,
        clear: false,
      })
    ).toEqual({
      ok: true,
      params: {
        tabId: 1,
        urlFilter: '/api/',
        method: 'POST',
        status: 200,
        limit: 30,
        clear: false,
      },
    });
  });
});

describe('3. Kesintisiz Yeniden Bağlanma Yöneticisi (lib/connection.js)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('RETRY_DELAYS_MS [1000, 2000, 5000] ile 2 denemede pes etmeden sürekli yeniden bağlanır', async () => {
    expect(RETRY_DELAYS_MS).toEqual([1_000, 2_000, 5_000]);

    const sockets = [];
    const settings = {
      enabled: true,
      connection: { url: 'ws://127.0.0.1:47653/', protocols: ['orkestra-chrome.v1'] },
    };

    const manager = createConnectionManager({
      readSettings: async () => ({ ...settings }),
      createSocket: (url) => {
        const ws = {
          url,
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close() {
            this.readyState = 3;
            this.onclose?.();
          },
          fail() {
            this.onerror?.();
            this.readyState = 3;
            this.onclose?.();
          },
          accept() {
            this.readyState = 1;
            this.onopen?.();
          },
        };
        sockets.push(ws);
        return ws;
      },
      onMessage: () => {},
    });

    await manager.connect();
    expect(sockets).toHaveLength(1);
    sockets[0].fail();
    expect(manager.status()).toEqual({ state: 'disconnected', lastError: CONNECT_ERROR });

    // 1. retry: 1000ms
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].fail();

    // 2. retry: 2000ms
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(3);
    sockets[2].fail();

    // 3. retry: 5000ms
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(4);
    sockets[3].fail();

    // 4. retry: yine 5000ms (pes etmez!)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(5);
    sockets[4].fail();

    // 5. retry: yine 5000ms
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(6);

    // Bağlantı kabul edilince sayaç sıfırlanır
    sockets[5].accept();
    expect(manager.status()).toEqual({ state: 'connected', lastError: '' });

    // Sonradan koparsa tekrar 1000ms'den başlar
    sockets[5].close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(7);

    // Kullanıcı duraklatırsa (disconnect) yeniden deneme durur
    settings.enabled = false;
    manager.disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(7);
  });
});

describe('4. Sayfa Fonksiyonları, React/Vue Uyumu ve İzolasyon (lib/page-functions.js)', () => {
  afterEach(() => {
    delete globalThis.__orkestraRefs;
    delete globalThis.__orkestraNextRef;
  });

  function makeEl(tag, attrs = {}, extra = {}) {
    const el = {
      tagName: tag.toUpperCase(),
      attrs: { ...attrs },
      isConnected: true,
      value: extra.value ?? '',
      checked: extra.checked ?? false,
      textContent: extra.textContent ?? '',
      innerText: extra.innerText ?? extra.textContent ?? '',
      events: [],
      eventObjects: [],
      clicks: 0,
      scrollLeft: 0,
      scrollTop: 0,
      ownerDocument: { defaultView: globalThis },
      getAttribute(name) {
        return name in this.attrs ? this.attrs[name] : null;
      },
      getBoundingClientRect() {
        return extra.rect ?? { left: 10, top: 20, width: 100, height: 30 };
      },
      dispatchEvent(ev) {
        this.events.push(ev.type);
        this.eventObjects.push(ev);
        return true;
      },
      focus() {},
      click() {
        this.clicks += 1;
      },
      scrollIntoView() {
        this.scrolledIntoView = true;
      },
      scrollBy({ left = 0, top = 0 }) {
        this.scrollLeft += left;
        this.scrollTop += top;
      },
      ...extra,
    };
    return el;
  }

  function makeDoc(elements, bodyText = 'Merhaba Orkestra') {
    const scrollingElement = {
      scrollLeft: 0,
      scrollTop: 0,
      scrollBy({ left = 0, top = 0 }) {
        this.scrollLeft += left;
        this.scrollTop += top;
      },
    };
    return {
      defaultView: {
        scrollX: 0,
        scrollY: 0,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        scrollBy({ left = 0, top = 0 }) {
          this.scrollX += left;
          this.scrollY += top;
          scrollingElement.scrollLeft = this.scrollX;
          scrollingElement.scrollTop = this.scrollY;
        },
      },
      scrollingElement,
      documentElement: scrollingElement,
      body: { innerText: bodyText, textContent: bodyText },
      activeElement: elements[0] ?? null,
      title: 'Test Sayfası',
      location: { href: 'https://orkestra.test/panel' },
      querySelectorAll: () => elements,
      querySelector: (sel) => elements.find((e) => e.attrs.id === sel.replace(/^#/, '')) ?? elements[0] ?? null,
      elementFromPoint: () => elements[0] ?? null,
    };
  }

  it('read_page (snapshotPage) ağaç, elements ve pageText üretir; contenteditable, onclick ve tabindex kapsar', () => {
    const btn = makeEl('button', { role: 'button' }, { textContent: 'Gönder' });
    const editor = makeEl('div', { contenteditable: 'true' }, { innerText: 'Taslak not' });
    const custom = makeEl('div', { onclick: 'run()', tabindex: '0' }, { textContent: 'Özel Öğe' });
    const pass = makeEl('input', { type: 'password', name: 'pwd' }, { value: 'gizli123' });

    const snap = snapshotPage(
      { maxChars: 5000, filter: 'interactive', maxElements: 100 },
      makeDoc([btn, editor, custom, pass])
    );

    expect(snap.elements).toHaveLength(4);
    expect(snap.elements.map((e) => e.ref)).toEqual(['ref_1', 'ref_2', 'ref_3', 'ref_4']);
    expect(snap.elements[1]).toMatchObject({
      ref: 'ref_2',
      tag: 'div',
      contentEditable: true,
      value: 'Taslak not',
    });
    expect(snap.elements[3]).toMatchObject({ ref: 'ref_4', forbidden: true });
    expect(snap.tree).toContain('[ref_1] button');
    expect(snap.tree).toContain('[ref_2] div');
    expect(snap.tree).toContain('[protected]');
    expect(JSON.stringify(snap)).not.toContain('gizli123');
    expect(snap.pageText).toBe('Merhaba Orkestra');
  });

  it('findInPage sorgu ve role göre eşleşenlere ref_N atar', () => {
    const saveBtn = makeEl('button', {}, { textContent: 'Kaydet' });
    const cancelBtn = makeEl('button', {}, { textContent: 'İptal' });
    const emailInput = makeEl('input', { type: 'email', placeholder: 'E-posta giriniz' });
    const doc = makeDoc([saveBtn, cancelBtn, emailInput]);

    const res = findInPage({ query: 'kaydet', role: 'button' }, doc);
    expect(res.ok).toBe(true);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({
      ref: 'ref_1',
      tag: 'button',
      role: 'button',
      text: 'Kaydet',
    });

    // Atanan ref ile doğrudan tıklanabilir
    const clickRes = clickRef({ ref: 'ref_1' }, doc);
    expect(clickRes).toMatchObject({ ok: true, clicked: true, ref: 'ref_1', tag: 'button' });
    expect(saveBtn.clicks).toBe(1);
  });

  it('clickRef tam PointerEvent + MouseEvent dizisi, dblclick ve contextmenu üretir', () => {
    const target = makeEl('button', { id: 'act' }, { textContent: 'Aç' });
    const doc = makeDoc([target]);
    snapshotPage(1000, doc);

    const rightClick = clickRef({ ref: 'ref_1', button: 'right' }, doc);
    expect(rightClick).toMatchObject({ ok: true, clicked: true, ref: 'ref_1' });
    expect(target.events).toContain('pointerdown');
    expect(target.events).toContain('mousedown');
    expect(target.events).toContain('pointerup');
    expect(target.events).toContain('mouseup');
    expect(target.events).toContain('contextmenu');

    target.events = [];
    const dblClick = clickRef({ ref: 'ref_1', double: true }, doc);
    expect(dblClick).toMatchObject({ ok: true, clicked: true });
    expect(target.events).toContain('dblclick');
  });

  it('typeRef React _valueTracker sıfırlaması, clear:false ekleme, contenteditable ve submit destekler', () => {
    let trackerResetWith = null;
    let submitted = 0;
    const input = makeEl(
      'input',
      { type: 'text' },
      {
        value: 'eski',
        _valueTracker: {
          setValue(v) {
            trackerResetWith = v;
          },
        },
        form: {
          requestSubmit() {
            submitted += 1;
          },
        },
      }
    );
    const editor = makeEl('div', { contenteditable: 'true' }, { innerText: 'Başlangıç ' });
    const doc = makeDoc([input, editor]);
    snapshotPage(1000, doc);

    const typed1 = typeRef({ ref: 'ref_1', text: 'yeni değer', clear: true, submit: true }, undefined, undefined, doc);
    expect(typed1).toEqual({ ok: true, typed: true, ref: 'ref_1', value: 'yeni değer' });
    expect(trackerResetWith).toBe('eski');
    expect(input.value).toBe('yeni değer');
    expect(input.events).toContain('keydown');
    expect(input.events).toContain('beforeinput');
    expect(input.events).toContain('input');
    expect(input.events).toContain('change');
    expect(input.events).toContain('keyup');
    expect(submitted).toBe(1);

    // clear: false mevcut metnin sonuna ekler
    const typed2 = typeRef({ ref: 'ref_2', text: 'eklendi', clear: false }, undefined, undefined, doc);
    expect(typed2).toEqual({ ok: true, typed: true, ref: 'ref_2', value: 'Başlangıç eklendi' });
    expect(editor.innerText).toBe('Başlangıç eklendi');
  });

  it('formInputRef select, checkbox, radio, range ve date elemanlarını React/Vue uyumlu günceller', () => {
    const opt1 = { value: 'tr', textContent: 'Türkçe', selected: false };
    const opt2 = { value: 'en', textContent: 'English', selected: false };
    const select = makeEl('select', {}, { value: 'tr', options: [opt1, opt2] });
    const checkbox = makeEl('input', { type: 'checkbox' }, { checked: false });
    const range = makeEl('input', { type: 'range' }, { value: '10' });
    const doc = makeDoc([select, checkbox, range]);
    snapshotPage(1000, doc);

    expect(formInputRef({ ref: 'ref_1', value: 'English' }, doc)).toEqual({
      ok: true,
      updated: true,
      ref: 'ref_1',
      tag: 'select',
      value: 'en',
    });
    expect(opt2.selected).toBe(true);
    expect(select.events).toEqual(['input', 'change']);

    expect(formInputRef({ ref: 'ref_2', value: true }, doc)).toEqual({
      ok: true,
      updated: true,
      ref: 'ref_2',
      tag: 'input',
      value: true,
    });
    expect(checkbox.checked).toBe(true);

    expect(formInputRef({ ref: 'ref_3', value: 75 }, doc)).toEqual({
      ok: true,
      updated: true,
      ref: 'ref_3',
      tag: 'input',
      value: '75',
    });
  });

  it('pressKeyInPage, scrollPage, getPageText, checkWaitCondition ve evaluateInPage eksiksiz çalışır', async () => {
    const box = makeEl('input', { type: 'text', id: 'search' });
    const doc = makeDoc([box], 'Hoş geldiniz Orkestra 2.0');
    snapshotPage(1000, doc);

    const keyRes = pressKeyInPage({ key: 'Meta+a', ref: 'ref_1' }, doc);
    expect(keyRes).toEqual({ ok: true, pressed: true, key: 'Meta+a' });
    expect(box.events).toContain('keydown');
    expect(box.events).toContain('keyup');

    const scrollRes = scrollPage({ direction: 'down', amount: 350 }, doc);
    expect(scrollRes).toEqual({ ok: true, scrolled: true, scrollX: 0, scrollY: 350 });

    const textRes = getPageText({ maxChars: 12 }, doc);
    expect(textRes).toMatchObject({ ok: true, text: 'Hoş geldiniz', truncated: true });

    expect(
      checkWaitCondition({ text: 'orkestra 2.0', textGone: 'yükleniyor', selector: '#search' }, doc)
    ).toEqual({ ok: true, matched: true });

    // evaluateInPage: Promise ve döngüsel nesne güvenliği
    const evalRes = await evaluateInPage(
      'Promise.resolve((() => { const a = { x: 42 }; a.self = a; return a; })())'
    );
    expect(evalRes).toEqual({
      ok: true,
      type: 'object',
      result: { x: 42, self: '[Circular]' },
    });
  });

  it('console ve network izleyicisi (lib/page-monitor.js + readConsolePage / readNetworkPage) fetch, XHR ve 200 halka tampon sınırıyla çalışır', async () => {
    console.warn('Deneme uyarısı', { kod: 123 });
    const consoleRes = readConsolePage({ level: 'warn', limit: 10, clear: true });
    expect(consoleRes.ok).toBe(true);
    expect(consoleRes.entries.some((e) => e.text.includes('Deneme uyarısı'))).toBe(true);

    // clear: true sonrası tampon temizlenir
    expect(readConsolePage({ level: 'all' }).entries).toHaveLength(0);

    // Halka tampon 200 sınırı ve fetch/XHR/error kancaları
    const listeners = {};
    class FakeXHR {
      open(method, url) {
        this.method = method;
        this.responseURL = url;
      }
      addEventListener(type, fn) {
        if (type === 'load') this._onload = fn;
      }
      send() {
        this.status = 201;
        this.statusText = 'Created';
        this._onload?.();
      }
    }
    const fakeWin = {
      console: {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      fetch: async (url, init) => ({
        url,
        status: 200,
        statusText: 'OK',
        ok: true,
        method: init?.method ?? 'GET',
      }),
      XMLHttpRequest: FakeXHR,
      performance: {
        getEntriesByType: () => [
          {
            name: 'https://api.orkestra.test/v1/users',
            initiatorType: 'fetch',
            duration: 42,
            responseStatus: 200,
          },
          {
            name: 'https://cdn.orkestra.test/app.js',
            initiatorType: 'script',
            duration: 15,
            responseStatus: 200,
          },
        ],
      },
    };

    globalThis.__orkestraInstallMonitor(fakeWin);
    for (let i = 0; i < 250; i += 1) {
      fakeWin.console.log(`satır-${i}`);
    }
    listeners.error?.({ message: 'Yakalanmamış hata', filename: 'app.js', lineno: 10 });
    listeners.unhandledrejection?.({ reason: new Error('Reddedilen söz') });

    const cappedConsole = readConsolePage({ level: 'all', limit: 500 }, fakeWin);
    expect(cappedConsole.entries).toHaveLength(200);
    expect(cappedConsole.entries[198].text).toContain('Yakalanmamış hata');
    expect(cappedConsole.entries[199].text).toContain('UnhandledRejection');

    await fakeWin.fetch('https://api.orkestra.test/v1/tasks', { method: 'POST' });
    const xhr = new fakeWin.XMLHttpRequest();
    xhr.open('PUT', 'https://api.orkestra.test/v1/items/5');
    xhr.send();

    const netRes = readNetworkPage({ urlFilter: '/v1/' }, fakeWin);
    expect(netRes.ok).toBe(true);
    expect(netRes.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://api.orkestra.test/v1/users',
      'POST https://api.orkestra.test/v1/tasks',
      'PUT https://api.orkestra.test/v1/items/5',
    ]);
  });

  it('tüm 12 sayfa fonksiyonu executeScript serileştirmesinde (self-contained) dış kapsama ihtiyaç duymadan çalışır', async () => {
    // oxlint-disable-next-line typescript/no-implied-eval
    const isolate = (fn) => new Function(`return (${String(fn)})`)();
    for (const fn of [
      snapshotPage,
      findInPage,
      getPageText,
      clickRef,
      typeRef,
      formInputRef,
      pressKeyInPage,
      scrollPage,
      evaluateInPage,
      checkWaitCondition,
      readConsolePage,
      readNetworkPage,
    ]) {
      const copy = isolate(fn);
      expect(typeof copy).toBe('function');
    }
  });
});

describe('5. Service Worker 18 Eylem Yürütücüsü (background.js)', () => {
  beforeEach(() => {
    const tabs = [
      { id: 10, windowId: 1, active: true, title: 'Orkestra', url: 'https://orkestra.test/' },
      { id: 11, windowId: 1, active: false, title: 'Ayarlar', url: 'chrome://settings' },
    ];
    globalThis.chrome = {
      storage: {
        local: {
          get: async () => ({ enabled: true }),
          set: async () => {},
        },
      },
      action: {
        setBadgeBackgroundColor: async () => {},
        setBadgeText: async () => {},
        setTitle: async () => {},
      },
      windows: {
        update: async (windowId) => ({ id: windowId, focused: true }),
      },
      tabs: {
        query: async () => tabs,
        get: async (id) => {
          const found = tabs.find((t) => t.id === id);
          if (!found) throw new Error('No tab');
          return found;
        },
        create: async ({ url, active }) => ({
          id: 12,
          windowId: 1,
          url,
          title: 'Yeni Sekme',
          active,
        }),
        remove: async () => {},
        update: async (id, patch) => {
          const found = tabs.find((t) => t.id === id) || { id, windowId: 1, title: 'Sekme' };
          Object.assign(found, patch);
          return found;
        },
        reload: async () => {},
        goBack: async () => {},
        goForward: async () => {},
        captureVisibleTab: async (_winId, opts) =>
          `data:image/${opts?.format === 'png' ? 'png' : 'jpeg'};base64,QUJDRA==`,
      },
      scripting: {
        executeScript: async ({ args }) => [{ result: { ok: true, args } }],
      },
    };
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('tabs_list, tab_create, tab_close, tab_select, navigate ve screenshot doğrudan çalışır', async () => {
    const listed = await handle('tabs_list', {});
    expect(listed.tabs).toHaveLength(2);
    expect(listed.tabs[0]).toMatchObject({
      id: 10,
      url: 'https://orkestra.test/',
      title: 'Orkestra',
      supported: true,
    });
    // chrome:// sekmesi supported: false döner ve URL sızdırmaz
    expect(listed.tabs[1]).toMatchObject({
      id: 11,
      supported: false,
      url: '',
    });

    const created = await handle('tab_create', { url: 'https://orkestra.test/yeni', active: true });
    expect(created).toMatchObject({
      tabId: 12,
      windowId: 1,
      url: 'https://orkestra.test/yeni',
      active: true,
    });

    const selected = await handle('tab_select', { tabId: 10 });
    expect(selected).toMatchObject({ tabId: 10, active: true });

    const closed = await handle('tab_close', { tabId: 10 });
    expect(closed).toEqual({ closed: true, tabId: 10, id: 10 });

    const shot = await handle('screenshot', { tabId: 10, format: 'png' });
    expect(shot).toEqual({
      tabId: 10,
      mimeType: 'image/png',
      data: 'QUJDRA==',
      dataUrl: 'data:image/png;base64,QUJDRA==',
    });
  });

  it('chrome://, file:// ve devtools:// sekmelerinde işlem yapılmasını unsupported_page ile engeller', async () => {
    await expect(handle('read_page', { tabId: 11 })).rejects.toThrow(BridgeFailure);
    await expect(handle('evaluate', { tabId: 11, expression: '1+1' })).rejects.toMatchObject({
      code: ERROR_CODES.unsupportedPage,
    });
    await expect(handle('tab_create', { url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: ERROR_CODES.unsupportedPage,
    });
    await expect(handle('navigate', { tabId: 10, url: 'devtools://devtools' })).rejects.toMatchObject(
      {
        code: ERROR_CODES.unsupportedPage,
      }
    );
  });

  it('masaüstünden gelen ping mesajına pong ile yanıt döner ve 18 eylemin tamamını background.handle üzerinden yürütür', async () => {
    const sent = [];
    const fakeWs = {
      readyState: 1,
      send: (msg) => sent.push(JSON.parse(msg)),
    };
    await onMessage(fakeWs, JSON.stringify({ type: 'ping' }));
    expect(sent).toEqual([{ type: 'pong' }]);

    // executeScript sahte yanıtlarını eyleme göre döndür
    globalThis.chrome.scripting.executeScript = async ({ func, args, world }) => {
      if (func === snapshotPage) {
        return [
          {
            result: {
              url: 'https://orkestra.test/',
              title: 'Orkestra',
              text: 'Merhaba',
              pageText: 'Merhaba',
              truncated: false,
              elements: [{ ref: 'ref_1', tag: 'button', name: 'Tıkla' }],
              tree: '[ref_1] button "Tıkla"',
            },
          },
        ];
      }
      if (func === findInPage) {
        return [
          {
            result: {
              ok: true,
              url: 'https://orkestra.test/',
              title: 'Orkestra',
              matches: [{ ref: 'ref_1', tag: 'button', text: 'Tıkla' }],
            },
          },
        ];
      }
      if (func === getPageText) {
        return [
          {
            result: {
              ok: true,
              url: 'https://orkestra.test/',
              title: 'Orkestra',
              text: 'Sayfa metni',
              truncated: false,
            },
          },
        ];
      }
      if (func === clickRef) {
        return [{ result: { ok: true, clicked: true, ref: 'ref_1', tag: 'button', x: 10, y: 20 } }];
      }
      if (func === typeRef) {
        return [{ result: { ok: true, typed: true, ref: 'ref_1', value: args[0].text } }];
      }
      if (func === formInputRef) {
        return [{ result: { ok: true, updated: true, ref: 'ref_1', tag: 'select', value: args[0].value } }];
      }
      if (func === pressKeyInPage) {
        return [{ result: { ok: true, pressed: true, key: args[0].key } }];
      }
      if (func === scrollPage) {
        return [{ result: { ok: true, scrolled: true, scrollX: 0, scrollY: 400 } }];
      }
      if (func === evaluateInPage) {
        expect(world).toBe('MAIN');
        return [{ result: { ok: true, result: 42, type: 'number' } }];
      }
      if (func === checkWaitCondition) {
        return [{ result: { ok: true, matched: true } }];
      }
      if (func === readConsolePage) {
        expect(world).toBe('MAIN');
        return [{ result: { ok: true, entries: [{ level: 'log', text: 'ok', timestamp: 1 }] } }];
      }
      if (func === readNetworkPage) {
        expect(world).toBe('MAIN');
        return [{ result: { ok: true, requests: [{ url: 'https://orkestra.test/api', method: 'GET', status: 200 }] } }];
      }
      return [{ result: { ok: true } }];
    };

    // tabId verilmediğinde aktif http/https sekmeyi (id: 10) otomatik çözer
    expect(await handle('navigate', { action: 'reload' })).toEqual({
      id: 10,
      tabId: 10,
      url: 'https://orkestra.test/',
      title: 'Orkestra',
    });
    expect(await handle('read_page', {})).toMatchObject({
      tabId: 10,
      url: 'https://orkestra.test/',
      tree: '[ref_1] button "Tıkla"',
    });
    expect(await handle('find', { query: 'Tıkla' })).toMatchObject({
      tabId: 10,
      matches: [{ ref: 'ref_1', tag: 'button', text: 'Tıkla' }],
    });
    expect(await handle('get_page_text', {})).toMatchObject({
      tabId: 10,
      text: 'Sayfa metni',
    });
    expect(await handle('click', { ref: 'ref_1' })).toMatchObject({
      clicked: true,
      tabId: 10,
      ref: 'ref_1',
    });
    expect(await handle('type', { ref: 'ref_1', text: 'merhaba' })).toMatchObject({
      typed: true,
      tabId: 10,
      ref: 'ref_1',
      value: 'merhaba',
    });
    expect(await handle('form_input', { ref: 'ref_1', value: 'tr' })).toMatchObject({
      updated: true,
      tabId: 10,
      ref: 'ref_1',
      tag: 'select',
      value: 'tr',
    });
    expect(await handle('press_key', { key: 'Enter' })).toMatchObject({
      pressed: true,
      tabId: 10,
      key: 'Enter',
    });
    expect(await handle('scroll', { direction: 'down', amount: 400 })).toMatchObject({
      scrolled: true,
      tabId: 10,
      scrollX: 0,
      scrollY: 400,
    });
    expect(await handle('evaluate', { expression: '21 * 2' })).toEqual({
      tabId: 10,
      result: 42,
      type: 'number',
    });
    expect(await handle('wait_for', { text: 'Merhaba' })).toMatchObject({
      matched: true,
      tabId: 10,
    });
    expect(await handle('console', { level: 'all' })).toEqual({
      tabId: 10,
      entries: [{ level: 'log', text: 'ok', timestamp: 1 }],
    });
    expect(await handle('network', { urlFilter: '/api' })).toEqual({
      tabId: 10,
      requests: [{ url: 'https://orkestra.test/api', method: 'GET', status: 200 }],
    });
  });

  it('aktif sekme chrome://extensions iken tabId verilmeden navigate çağrılırsa otomatik yeni sekme açar', async () => {
    globalThis.chrome.tabs.query = async () => [
      { id: 11, windowId: 1, active: true, title: 'Uzantılar', url: 'chrome://extensions' },
    ];
    const nav = await handle('navigate', { url: 'https://orkestra.test/otomatik' });
    expect(nav).toMatchObject({
      tabId: 12,
      url: 'https://orkestra.test/otomatik',
    });
  });

  it('showAgentOverlay ve hideAgentOverlay executeScript serileştirmesinde öz-yeterlidir', () => {
    // oxlint-disable-next-line typescript/no-implied-eval
    const isolate = (fn) => new Function(`return (${String(fn)})`)();
    expect(typeof isolate(showAgentOverlay)).toBe('function');
    expect(typeof isolate(hideAgentOverlay)).toBe('function');
  });
});
