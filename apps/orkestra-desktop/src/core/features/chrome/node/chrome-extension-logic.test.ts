import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clickRef,
  snapshotPage,
  typeRef,
} from '../../../../../../chrome-extension/lib/page-functions.js';
import {
  ACTIONS,
  buildConnection,
  isElementRef,
  isForbiddenField,
  isSupportedPageUrl,
  isUrlPermitted,
  originPattern,
  parseServerMessage,
} from '../../../../../../chrome-extension/lib/policy.js';

// Uzantının saf mantığı (apps/chrome-extension/lib): DOM'suz ve chrome API'siz test edilir.

describe('isSupportedPageUrl', () => {
  it.each(['https://example.com/', 'http://localhost:3000/x?y=1', 'https://a.b.c/path#h'])(
    'accepts %s',
    (url) => expect(isSupportedPageUrl(url)).toBe(true)
  );

  it.each([
    'chrome://settings',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,hi',
    'view-source:https://example.com',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'https://user:pass@example.com/',
    'not a url',
    '',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('rejects %s', (url) => expect(isSupportedPageUrl(url)).toBe(false));

  it('rejects non-strings', () => {
    expect(isSupportedPageUrl(undefined)).toBe(false);
    expect(isSupportedPageUrl(42)).toBe(false);
  });
});

describe('originPattern and isUrlPermitted', () => {
  it('builds host permission patterns without the port', () => {
    expect(originPattern('https://Example.com:8443/a?b')).toBe('https://example.com/*');
    expect(originPattern('http://localhost:3000/')).toBe('http://localhost/*');
    expect(originPattern('chrome://settings')).toBeNull();
  });

  it('permits only exactly granted origins', () => {
    const granted = ['https://example.com/*'];
    expect(isUrlPermitted('https://example.com/x', granted)).toBe(true);
    expect(isUrlPermitted('http://example.com/x', granted)).toBe(false);
    expect(isUrlPermitted('https://evil.com/x', granted)).toBe(false);
    expect(isUrlPermitted('https://sub.example.com/', granted)).toBe(false);
    expect(isUrlPermitted('chrome://settings', granted)).toBe(false);
    expect(isUrlPermitted(undefined, granted)).toBe(false);
  });
});

describe('isForbiddenField', () => {
  it.each([
    [{ type: 'password' }],
    [{ type: 'PASSWORD' }],
    [{ type: 'text', autocomplete: 'cc-number' }],
    [{ type: 'text', autocomplete: 'section-pay cc-exp' }],
    [{ type: 'text', autocomplete: 'CC-CSC' }],
    [{ type: 'text', autocomplete: 'current-password' }],
    [{ type: 'text', autocomplete: 'new-password' }],
    [{ type: 'text', name: 'cardnumber' }],
    [{ type: 'text', id: 'card-number' }],
    [{ type: 'text', name: 'cvv' }],
    [{ type: 'text', id: 'security_code' }],
  ])('forbids %j', (field) => expect(isForbiddenField(field)).toBe(true));

  it.each([
    [{ type: 'text' }],
    [{ type: 'email', autocomplete: 'email' }],
    [{ tag: 'textarea' }],
    [{ type: 'text', autocomplete: 'name' }],
    [{ type: 'text', name: 'discard', id: 'cardigan-search' }],
    [null],
    [undefined],
  ])('allows %j', (field) => expect(isForbiddenField(field)).toBe(false));
});

describe('parseServerMessage', () => {
  const request = (action: string, params: unknown, id = 'r1') =>
    JSON.stringify({ type: 'request', id, action, params });

  it('accepts known requests with validated params', () => {
    expect(parseServerMessage(request('tabs_list', {}))).toEqual({
      ok: true,
      kind: 'request',
      request: { id: 'r1', action: 'tabs_list', params: {} },
    });
    expect(parseServerMessage(request('click', { tab: 4, ref: 'ref_9' }))).toMatchObject({
      ok: true,
      request: { action: 'click', params: { tab: 4, ref: 'ref_9' } },
    });
    expect(parseServerMessage(JSON.stringify({ type: 'ping' }))).toEqual({
      ok: true,
      kind: 'ping',
    });
  });

  it('drops unexpected parameters', () => {
    const parsed = parseServerMessage(request('click', { tab: 1, ref: 'ref_1', code: 'alert(1)' }));
    expect(parsed).toMatchObject({ ok: true, request: { params: { tab: 1, ref: 'ref_1' } } });
    expect(JSON.stringify(parsed)).not.toContain('alert');
  });

  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['a number', '1'],
    ['an unknown type', JSON.stringify({ type: 'exec' })],
    ['an unknown action', request('evaluate', { code: '1' })],
    ['an unknown action (cookies)', request('cookies_get', {})],
    ['a missing id', JSON.stringify({ type: 'request', action: 'tabs_list' })],
    ['an overlong id', request('tabs_list', {}, 'x'.repeat(65))],
    ['a non-http navigate', request('navigate', { tab: 1, url: 'file:///etc/passwd' })],
    ['a chrome:// tab_create', request('tab_create', { url: 'chrome://settings' })],
    ['a fractional tab id', request('read_page', { tab: 1.5 })],
    ['a negative tab id', request('read_page', { tab: -1 })],
    ['a string tab id', request('screenshot', { tab: '1' })],
    ['a bad ref', request('click', { tab: 1, ref: 'e1' })],
    ['a ref with markup', request('click', { tab: 1, ref: 'ref_1"]' })],
    ['too much typed text', request('type', { tab: 1, ref: 'ref_1', text: 'x'.repeat(10_001) })],
    ['a non-boolean submit', request('type', { tab: 1, ref: 'ref_1', text: 'a', submit: 'yes' })],
    ['an out-of-range maxChars', request('read_page', { tab: 1, maxChars: 0 })],
  ])('rejects %s', (_name, raw) => {
    expect(parseServerMessage(raw)).toMatchObject({ ok: false });
  });

  it('rejects oversized frames and non-text input', () => {
    expect(parseServerMessage('x'.repeat(70_000))).toMatchObject({ ok: false });
    expect(parseServerMessage(new ArrayBuffer(8))).toMatchObject({ ok: false });
  });

  it('exposes all 18 supported actions', () => {
    expect([...ACTIONS]).toEqual([
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
  });
});

describe('isElementRef and buildConnection', () => {
  it('accepts only ref_N', () => {
    expect(isElementRef('ref_1')).toBe(true);
    expect(isElementRef('ref_')).toBe(false);
    expect(isElementRef('ref_1; drop')).toBe(false);
    expect(isElementRef(1)).toBe(false);
  });

  it('builds a zero-friction loopback connection without requiring a token, and supports optional 64-hex token', () => {
    expect(buildConnection()).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1'],
    });
    expect(buildConnection({ port: 47653 })).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1'],
    });
    const token = 'ab'.repeat(32);
    expect(buildConnection({ token, port: 47653 })).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1', `token.${token}`],
    });
    expect(buildConnection({ token: 'short', port: 47653 })).toEqual({
      url: 'ws://127.0.0.1:47653/',
      protocols: ['orkestra-chrome.v1'],
    });
    expect(buildConnection({ token, port: 80 })).toBeNull();
  });
});

// --- Sayfa fonksiyonları: sahte belge ile ---

type FakeEl = {
  tagName: string;
  attrs: Record<string, string>;
  isConnected: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  value?: string;
  checked?: boolean;
  textContent?: string;
  labels?: Array<{ textContent: string }>;
  form?: { requestSubmit(): void };
  events: string[];
  clicks: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  dispatchEvent(event: { type: string }): boolean;
  focus(): void;
  click(): void;
  scrollIntoView(): void;
};

function el(tag: string, attrs: Record<string, string> = {}, extra: Partial<FakeEl> = {}): FakeEl {
  const element: FakeEl = {
    tagName: tag.toUpperCase(),
    attrs,
    isConnected: true,
    events: [],
    clicks: 0,
    getAttribute: (name) => (name in attrs ? (attrs[name] ?? null) : null),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    dispatchEvent: (event) => (element.events.push(event.type), true),
    focus: () => undefined,
    click: () => void (element.clicks += 1),
    scrollIntoView: () => undefined,
    ...extra,
  };
  return element;
}

function fakeDocument(elements: FakeEl[], bodyText = 'Hello world') {
  const doc = {
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    querySelectorAll: () => elements,
    body: { innerText: bodyText },
    title: 'Fake page',
    location: { href: 'https://example.test/page' },
  };
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

describe('page functions', () => {
  afterEach(() => {
    delete (globalThis as { __orkestraRefs?: unknown }).__orkestraRefs;
    delete (globalThis as { document?: unknown }).document;
  });

  const snapshot = (elements: FakeEl[], max = 20_000, text?: string) => {
    const doc = fakeDocument(elements, text);
    (globalThis as { document?: unknown }).document = doc;
    return snapshotPage(max, doc as never);
  };

  it('lists interactive elements with refs and never reads protected field values', () => {
    const email = el('input', { type: 'email', name: 'email' }, { value: 'me@example.test' });
    const password = el('input', { type: 'password' }, { value: 'hunter2' });
    const card = el(
      'input',
      { type: 'text', autocomplete: 'cc-number' },
      { value: '4111111111111111' }
    );
    const hidden = el('input', { type: 'hidden' }, { value: 'csrf' });
    const link = el('a', { href: '/next' }, { textContent: 'Next' });
    const result = snapshot([email, password, card, hidden, link]);

    expect(result.elements.map((e) => e.ref)).toEqual(['ref_1', 'ref_2', 'ref_3', 'ref_4']);
    expect(result.elements[0]).toMatchObject({
      tag: 'input',
      type: 'email',
      value: 'me@example.test',
    });
    expect(result.elements[1]).toMatchObject({ forbidden: true });
    expect(result.elements[2]).toMatchObject({ forbidden: true });
    expect(result.elements[3]).toMatchObject({ tag: 'a', href: '/next', name: 'Next' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('csrf');
  });

  it('truncates page text', () => {
    const result = snapshot([], 5, 'abcdefghij');
    expect(result).toMatchObject({ text: 'abcde', truncated: true });
  });

  it('clicks a ref from the latest snapshot and reports stale refs', () => {
    const button = el('button', {}, { textContent: 'Go' });
    snapshot([button]);
    expect(clickRef('ref_1')).toEqual({ ok: true });
    expect(button.clicks).toBe(1);
    button.isConnected = false;
    expect(clickRef('ref_1')).toEqual({ ok: false, code: 'no_such_element' });
    expect(clickRef('ref_9')).toEqual({ ok: false, code: 'no_such_element' });
  });

  it('types into text fields and fires input/change events', () => {
    let submitted = 0;
    const field = el(
      'input',
      { type: 'text' },
      { value: 'old', form: { requestSubmit: () => void submitted++ } }
    );
    snapshot([field]);
    expect(typeRef('ref_1', 'new text', true)).toEqual({ ok: true });
    expect(field.value).toBe('new text');
    expect(field.events).toEqual(['input', 'change']);
    expect(submitted).toBe(1);
  });

  it.each([
    ['a password field', { type: 'password' }],
    ['a card number field', { type: 'text', autocomplete: 'cc-number' }],
    ['a card expiry field', { type: 'tel', autocomplete: 'cc-exp' }],
    ['a saved-password field', { type: 'text', autocomplete: 'current-password' }],
  ])('refuses to type into %s', (_name, attrs) => {
    const field = el('input', attrs, { value: '' });
    snapshot([field]);
    expect(typeRef('ref_1', 'secret', false)).toEqual({ ok: false, code: 'forbidden_field' });
    expect(field.value).toBe('');
    expect(field.events).toEqual([]);
  });

  it('checks the field at typing time, not only at snapshot time', () => {
    const field = el('input', { type: 'text' }, { value: '' });
    snapshot([field]);
    field.attrs.type = 'password'; // sayfa, görüntüden sonra alanı şifre alanına çevirdi
    expect(typeRef('ref_1', 'x', false)).toEqual({ ok: false, code: 'forbidden_field' });
  });

  it.each([['cardnumber'], ['cc-csc'], ['cvv'], ['security_code']])(
    'refuses to type into a field named %s, in line with the policy module',
    (name) => {
      expect(isForbiddenField({ name })).toBe(true);
      const field = el('input', { type: 'text', name }, { value: '' });
      snapshot([field]);
      expect(typeRef('ref_1', '4111', false)).toEqual({ ok: false, code: 'forbidden_field' });
    }
  );

  it('works when serialized the way chrome.scripting.executeScript sends it (self-contained)', () => {
    // executeScript yalnızca fonksiyonun kaynağını taşır; modül kapsamındaki sabitlere erişemez.
    // Test amaçlı: yalnızca uzantının kendi sabit fonksiyon kaynağı değerlendirilir.
    // oxlint-disable-next-line typescript/no-implied-eval
    const isolate = <T>(fn: T): T => new Function(`return (${String(fn)})`)() as T;
    const isolatedSnapshot = isolate(snapshotPage);
    const isolatedType = isolate(typeRef);
    const isolatedClick = isolate(clickRef);
    const field = el('input', { type: 'text' }, { value: '' });
    const password = el('input', { type: 'password' }, { value: 'x' });
    const result = isolatedSnapshot(100, fakeDocument([field, password]) as never);
    expect(result.elements).toHaveLength(2);
    expect(isolatedType('ref_1', 'hi', false)).toEqual({ ok: true });
    expect(isolatedType('ref_2', 'hi', false)).toEqual({ ok: false, code: 'forbidden_field' });
    expect(isolatedClick('ref_1')).toEqual({ ok: true });
  });

  it('refuses non-text targets, disabled and read-only fields', () => {
    const checkbox = el('input', { type: 'checkbox' });
    const button = el('button');
    const disabled = el('input', { type: 'text' }, { disabled: true });
    const readOnly = el('input', { type: 'text' }, { readOnly: true });
    snapshot([checkbox, button, disabled, readOnly]);
    for (const ref of ['ref_1', 'ref_2', 'ref_3', 'ref_4']) {
      expect(typeRef(ref, 'x', false)).toMatchObject({ ok: false, code: 'failed' });
    }
  });
});

describe('extension manifest', () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../../../chrome-extension/manifest.json', import.meta.url)),
      'utf8'
    )
  ) as {
    manifest_version: number;
    permissions: string[];
    host_permissions?: string[];
    optional_host_permissions?: string[];
    optional_permissions?: string[];
  };

  it('is MV3 with direct host_permissions for zero extra site prompts', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.optional_host_permissions).toBeUndefined();
  });

  it('does not request cookie, history, password, download or debugger permissions', () => {
    const requested = [...manifest.permissions, ...(manifest.optional_permissions ?? [])];
    for (const forbidden of [
      'cookies',
      'history',
      'downloads',
      'passwordsPrivate',
      'debugger',
      'webRequest',
      'management',
      'nativeMessaging',
    ]) {
      expect(requested).not.toContain(forbidden);
    }
  });
});
