// `chrome.scripting.executeScript({ func })` ile sayfaya enjekte edilen kendi kendine yeterli
// (self-contained) fonksiyonlar. Chrome yalnızca fonksiyonun kaynağını (`fn.toString()`) taşıdığı
// için hiçbir fonksiyon dış modül kapsamındaki değişken veya yardımcılara başvurmaz.

/**
 * Görünür metni ve etkileşimli öğeleri (`ref_1..ref_N`) döndürür. Şifre ve kart alanları
 * listelenir ama değerleri asla okunmaz.Hem eski `snapshotPage(maxChars, doc)` hem de yeni
 * `snapshotPage({ maxChars, filter, rootRef, maxElements }, doc)` çağrı biçimini destekler.
 * @param {number | { maxChars?: number, filter?: 'interactive' | 'all', rootRef?: string, maxElements?: number }} [optionsOrMaxChars]
 * @param {Document} [doc]
 */
export function snapshotPage(optionsOrMaxChars = 20000, doc = document) {
  const opts =
    typeof optionsOrMaxChars === 'object' && optionsOrMaxChars !== null
      ? optionsOrMaxChars
      : { maxChars: optionsOrMaxChars };
  const maxChars = opts.maxChars ?? 20000;
  const filter = opts.filter === 'all' ? 'all' : 'interactive';
  const maxElements = Math.max(1, Math.min(Number(opts.maxElements) || 400, 5000));
  const rootRef = typeof opts.rootRef === 'string' ? opts.rootRef : undefined;

  const win = (doc && doc.defaultView) || globalThis;
  const cardName =
    /card.?(number|num|no)\b|\bcc.?(num|number|csc|cvc|cvv|exp)|\bcvv\b|\bcvc\b|security.?code/i;
  const interactiveSelector = [
    'a[href]',
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    '[contenteditable]',
    '[role]',
    '[onclick]',
    '[tabindex]',
  ].join(',');
  const allSelector = [
    interactiveSelector,
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'label',
    'p',
    'li',
    'td',
    'th',
    'nav',
    'main',
    'header',
    'footer',
    'section',
    'article',
    'dialog',
    'form',
  ].join(',');

  const forbidden = (el) => {
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (type === 'password') return true;
    const nameAttr = (el.getAttribute && el.getAttribute('name')) || '';
    const idAttr = (el.getAttribute && el.getAttribute('id')) || '';
    if (cardName.test(`${nameAttr} ${idAttr}`)) return true;
    const tokens = String((el.getAttribute && el.getAttribute('autocomplete')) || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.some(
      (t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password'
    );
  };

  const visible = (el) => {
    if (!el || el.isConnected === false) return false;
    if (typeof el.closest === 'function' && el.closest('[data-orkestra-overlay]')) return false;
    if (win && typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  };

  const clip = (value, max) => {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  let queryRoot = doc;
  if (rootRef) {
    const prevStore = globalThis.__orkestraRefs;
    const weak = prevStore && typeof prevStore.get === 'function' ? prevStore.get(rootRef) : null;
    const resolvedRoot = weak && typeof weak.deref === 'function' ? weak.deref() : null;
    if (!resolvedRoot || resolvedRoot.isConnected === false) {
      return {
        ok: false,
        code: 'no_such_element',
        message: `Root element ${rootRef} is no longer in the document.`,
      };
    }
    queryRoot = resolvedRoot;
  }

  const selector = filter === 'all' ? allSelector : interactiveSelector;
  const store = new Map();
  const elements = [];
  const treeLines = [];
  const rawNodes =
    queryRoot && typeof queryRoot.querySelectorAll === 'function'
      ? queryRoot.querySelectorAll(selector)
      : [];

  for (const el of rawNodes) {
    if (elements.length >= maxElements) break;
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (type === 'hidden' || !visible(el)) continue;
    const tabindex = el.getAttribute ? el.getAttribute('tabindex') : null;
    const tag = String(el.tagName || '').toLowerCase();
    const contentEditableAttr = el.getAttribute ? el.getAttribute('contenteditable') : null;
    const isContentEditable =
      el.isContentEditable === true ||
      (contentEditableAttr !== null && contentEditableAttr.toLowerCase() !== 'false');

    // filter === 'interactive' iken yalnız tab ile odaklanamayan boş tabindex="-1" kapsayıcıları ele
    if (
      filter === 'interactive' &&
      tabindex === '-1' &&
      !['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag) &&
      !isContentEditable &&
      !(el.getAttribute && el.getAttribute('role')) &&
      !(el.getAttribute && el.getAttribute('onclick'))
    ) {
      continue;
    }

    const isForbidden = forbidden(el);
    const ref = `ref_${elements.length + 1}`;
    store.set(ref, new WeakRef(el));

    const ariaLabel = (el.getAttribute && el.getAttribute('aria-label')) || '';
    const labelText =
      ariaLabel ||
      (el.labels && el.labels[0] ? el.labels[0].textContent : '') ||
      (el.getAttribute && el.getAttribute('placeholder')) ||
      el.textContent ||
      (el.getAttribute && el.getAttribute('title')) ||
      (el.getAttribute && el.getAttribute('name')) ||
      '';
    const role = (el.getAttribute && el.getAttribute('role')) || undefined;
    const placeholder = (el.getAttribute && el.getAttribute('placeholder')) || undefined;

    const entry = {
      ref,
      tag,
      role,
      type: type || undefined,
      name: clip(labelText, 120),
      ...(placeholder ? { placeholder: clip(placeholder, 120) } : {}),
      ...(isContentEditable ? { contentEditable: true } : {}),
      disabled: el.disabled === true ? true : undefined,
      forbidden: isForbidden ? true : undefined,
    };

    if (tag === 'a') {
      const href = el.getAttribute && el.getAttribute('href');
      if (href) entry.href = clip(href, 200);
    }
    if (
      !isForbidden &&
      (tag === 'input' || tag === 'textarea' || tag === 'select' || isContentEditable)
    ) {
      if (type === 'checkbox' || type === 'radio') {
        entry.checked = el.checked === true;
      } else if (isContentEditable && tag !== 'input' && tag !== 'textarea') {
        const editableText = clip(el.innerText ?? el.textContent ?? '', 120);
        if (editableText) entry.value = editableText;
      } else {
        entry.value = clip(el.value, 120);
      }
    }
    elements.push(entry);

    const parts = [`[${ref}]`, tag + (type ? `[${type}]` : '')];
    if (role) parts.push(`role="${role}"`);
    if (entry.name) parts.push(JSON.stringify(entry.name));
    if (entry.placeholder && entry.placeholder !== entry.name) {
      parts.push(`placeholder=${JSON.stringify(entry.placeholder)}`);
    }
    if (entry.href) parts.push(`href=${JSON.stringify(entry.href)}`);
    if (entry.checked !== undefined) parts.push(entry.checked ? '[checked]' : '[unchecked]');
    if (entry.value) parts.push(`value=${JSON.stringify(entry.value)}`);
    if (entry.disabled) parts.push('[disabled]');
    if (entry.forbidden) parts.push('[protected]');
    treeLines.push(parts.join(' '));
  }

  globalThis.__orkestraRefs = store;
  globalThis.__orkestraNextRef = elements.length + 1;

  const textSource = rootRef && queryRoot !== doc ? queryRoot : doc.body;
  let text = textSource ? String(textSource.innerText ?? textSource.textContent ?? '') : '';
  const limit = Math.max(1, Math.min(Number(maxChars) || 20000, 200000));
  const truncated = text.length > limit;
  if (truncated) text = text.slice(0, limit);

  return {
    url: String((doc.location && doc.location.href) || ''),
    title: String(doc.title || ''),
    text,
    pageText: text,
    truncated,
    elements,
    tree: treeLines.join('\n'),
  };
}

/**
 * Sayfada metin, etiket, placeholder, rol veya CSS seçici ile eleman arar ve eşleşenlere
 * `[ref_N]` atayarak döndürür.
 * @param {{ query?: string, selector?: string, role?: string, limit?: number }} [options]
 * @param {Document} [doc]
 */
export function findInPage(options = {}, doc = document) {
  const win = (doc && doc.defaultView) || globalThis;
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const selector = typeof options.selector === 'string' ? options.selector.trim() : '';
  const roleFilter = typeof options.role === 'string' ? options.role.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 500));

  const cardName =
    /card.?(number|num|no)\b|\bcc.?(num|number|csc|cvc|cvv|exp)|\bcvv\b|\bcvc\b|security.?code/i;
  const forbidden = (el) => {
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (type === 'password') return true;
    const nameAttr = (el.getAttribute && el.getAttribute('name')) || '';
    const idAttr = (el.getAttribute && el.getAttribute('id')) || '';
    if (cardName.test(`${nameAttr} ${idAttr}`)) return true;
    const tokens = String((el.getAttribute && el.getAttribute('autocomplete')) || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.some(
      (t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password'
    );
  };

  const visible = (el) => {
    if (!el || el.isConnected === false) return false;
    if (typeof el.closest === 'function' && el.closest('[data-orkestra-overlay]')) return false;
    if (win && typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  };

  const clip = (value, max) => {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  const implicitRole = (el) => {
    const explicit = String((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
    if (explicit) return explicit;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) {
      return 'button';
    }
    if (tag === 'a' && el.getAttribute && el.getAttribute('href')) return 'link';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || (tag === 'input' && !['hidden', 'checkbox', 'radio'].includes(type))) {
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    return '';
  };

  let candidates;
  if (selector) {
    try {
      candidates = Array.from(doc.querySelectorAll(selector));
    } catch {
      return { ok: false, code: 'failed', message: `Invalid CSS selector: ${selector}` };
    }
  } else {
    const defaultSelector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      '[contenteditable]',
      '[role]',
      '[onclick]',
      '[tabindex]',
      'label',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'li',
      'td',
      'th',
      'span',
    ].join(',');
    candidates = Array.from(doc.querySelectorAll(defaultSelector));
  }

  let store = globalThis.__orkestraRefs;
  if (!(store instanceof Map)) {
    store = new Map();
    globalThis.__orkestraRefs = store;
  }
  let nextRefNum =
    typeof globalThis.__orkestraNextRef === 'number' && globalThis.__orkestraNextRef >= 1
      ? globalThis.__orkestraNextRef
      : store.size + 1;

  const findExistingRef = (target) => {
    for (const [k, weak] of store.entries()) {
      if (weak && typeof weak.deref === 'function' && weak.deref() === target) return k;
    }
    return null;
  };

  const matches = [];
  for (const el of candidates) {
    if (matches.length >= limit) break;
    const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (type === 'hidden' || !visible(el)) continue;

    const role = implicitRole(el);
    if (roleFilter && role !== roleFilter) continue;

    const tag = String(el.tagName || '').toLowerCase();
    const isForbidden = forbidden(el);
    const ariaLabel = (el.getAttribute && el.getAttribute('aria-label')) || '';
    const labelText =
      ariaLabel || (el.labels && el.labels[0] ? el.labels[0].textContent : '') || '';
    const placeholder = (el.getAttribute && el.getAttribute('placeholder')) || '';
    const textContent = el.innerText ?? el.textContent ?? '';
    const titleAttr = (el.getAttribute && el.getAttribute('title')) || '';
    const nameAttr = (el.getAttribute && el.getAttribute('name')) || '';
    const idAttr = (el.getAttribute && el.getAttribute('id')) || '';
    const valueText =
      !isForbidden && (tag === 'input' || tag === 'textarea' || tag === 'select')
        ? String(el.value ?? '')
        : '';

    if (query) {
      const haystack = [
        labelText,
        placeholder,
        textContent,
        titleAttr,
        nameAttr,
        idAttr,
        valueText,
        tag,
        role,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }

    let ref = findExistingRef(el);
    if (!ref) {
      ref = `ref_${nextRefNum++}`;
      store.set(ref, new WeakRef(el));
    }

    const r =
      typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };

    const item = {
      ref,
      tag,
      ...(role ? { role } : {}),
      ...(type ? { type } : {}),
      text: clip(textContent || labelText || placeholder, 120),
      ...(labelText ? { label: clip(labelText, 120) } : {}),
      ...(placeholder ? { placeholder: clip(placeholder, 120) } : {}),
      ...(valueText ? { value: clip(valueText, 120) } : {}),
      rect: {
        x: Math.round(r.left ?? r.x ?? 0),
        y: Math.round(r.top ?? r.y ?? 0),
        width: Math.round(r.width ?? 0),
        height: Math.round(r.height ?? 0),
      },
    };
    matches.push(item);
  }

  globalThis.__orkestraNextRef = nextRefNum;
  return {
    ok: true,
    url: String((doc.location && doc.location.href) || ''),
    title: String(doc.title || ''),
    matches,
  };
}

/**
 * Sayfanın veya belirtilen seçici/ref'in görünür metnini döndürür.
 * @param {{ selector?: string, ref?: string, maxChars?: number }} [options]
 * @param {Document} [doc]
 */
export function getPageText(options = {}, doc = document) {
  let target = null;
  if (typeof options.ref === 'string') {
    const store = globalThis.__orkestraRefs;
    const weak = store && typeof store.get === 'function' ? store.get(options.ref) : null;
    target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
    if (!target || target.isConnected === false) {
      return { ok: false, code: 'no_such_element' };
    }
  } else if (typeof options.selector === 'string' && options.selector.trim() !== '') {
    try {
      target = doc.querySelector(options.selector);
    } catch {
      return { ok: false, code: 'failed', message: `Invalid CSS selector: ${options.selector}` };
    }
    if (!target) {
      return {
        ok: false,
        code: 'no_such_element',
        message: `No element matches selector ${options.selector}.`,
      };
    }
  } else {
    target = doc.body || doc.documentElement;
  }

  let text = target ? String(target.innerText ?? target.textContent ?? '').trim() : '';
  const limit = Math.max(1, Math.min(Number(options.maxChars) || 50000, 200000));
  const truncated = text.length > limit;
  if (truncated) text = text.slice(0, limit);

  return {
    ok: true,
    url: String((doc.location && doc.location.href) || ''),
    title: String(doc.title || ''),
    text,
    truncated,
  };
}

/**
 * Bir öğeyi `ref`, `selector` veya `(x, y)` koordinatıyla tıklar.
 * Hem eski `clickRef('ref_1')` hem yeni `clickRef({ ref, selector, x, y, button, double })`
 * biçimini destekler; tam `PointerEvent` + `MouseEvent` dizisi, sağ tıklama (`contextmenu`)
 * ve çift tıklama (`dblclick`) olaylarını üretir.
 * @param {string | { ref?: string, selector?: string, x?: number, y?: number, button?: 'left' | 'right' | 'middle', double?: boolean }} targetOrOptions
 * @param {Document} [doc]
 */
export function clickRef(targetOrOptions, doc = document) {
  const isLegacyString = typeof targetOrOptions === 'string';
  const opts = isLegacyString ? { ref: targetOrOptions } : targetOrOptions || {};
  const buttonName = opts.button || 'left';
  const isDouble = opts.double === true;

  let el = undefined;
  let usedRef = opts.ref;
  if (typeof opts.ref === 'string') {
    const store = globalThis.__orkestraRefs;
    const weak = store && typeof store.get === 'function' ? store.get(opts.ref) : undefined;
    el = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
    if (!el || el.isConnected === false) return { ok: false, code: 'no_such_element' };
  } else if (typeof opts.selector === 'string' && opts.selector.trim() !== '') {
    try {
      el = doc.querySelector(opts.selector);
    } catch {
      return { ok: false, code: 'failed', message: `Invalid CSS selector: ${opts.selector}` };
    }
    if (!el || el.isConnected === false) return { ok: false, code: 'no_such_element' };
  } else if (typeof opts.x === 'number' && typeof opts.y === 'number') {
    if (typeof doc.elementFromPoint === 'function') {
      el = doc.elementFromPoint(opts.x, opts.y);
    }
    if (!el) return { ok: false, code: 'no_such_element', message: 'No element at coordinates.' };
  } else {
    return { ok: false, code: 'no_such_element' };
  }

  if (el.disabled === true) {
    return { ok: false, code: 'failed', message: 'The element is disabled.' };
  }

  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }

  const rect =
    typeof el.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : { left: 0, top: 0, width: 10, height: 10 };
  const clientX =
    typeof opts.x === 'number'
      ? opts.x
      : Math.round((rect.left ?? 0) + (rect.width ?? 0) / 2);
  const clientY =
    typeof opts.y === 'number'
      ? opts.y
      : Math.round((rect.top ?? 0) + (rect.height ?? 0) / 2);

  const buttonCode = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
  const buttonsMask = buttonName === 'right' ? 2 : buttonName === 'middle' ? 4 : 1;
  const win = (el.ownerDocument && el.ownerDocument.defaultView) || (doc && doc.defaultView) || globalThis;

  const fireMouse = (type, detailCount = 1, activeButtons = buttonsMask) => {
    if (typeof el.dispatchEvent !== 'function') return;
    try {
      const MouseCtor = (win && win.MouseEvent) || globalThis.MouseEvent;
      const PointerCtor = (win && win.PointerEvent) || globalThis.PointerEvent;
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        button: buttonCode,
        buttons: activeButtons,
        detail: detailCount,
      };
      if (type.startsWith('pointer') && typeof PointerCtor === 'function') {
        el.dispatchEvent(new PointerCtor(type, { ...init, pointerId: 1, isPrimary: true }));
      } else if (typeof MouseCtor === 'function') {
        el.dispatchEvent(new MouseCtor(type, init));
      } else if (typeof Event === 'function') {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    } catch {
      // Sahte DOM ortamında Event yoksa yoksay.
    }
  };

  if (!isLegacyString || el.ownerDocument) {
    fireMouse('pointerover', 0, 0);
    fireMouse('mouseover', 0, 0);
    fireMouse('pointerdown', 1, buttonsMask);
    fireMouse('mousedown', 1, buttonsMask);
    if (typeof el.focus === 'function') el.focus();
    fireMouse('pointerup', 1, 0);
    fireMouse('mouseup', 1, 0);
  }

  if (buttonName === 'right') {
    fireMouse('contextmenu', 1, 0);
  } else if (buttonName === 'middle') {
    fireMouse('auxclick', 1, 0);
  } else {
    if (typeof el.click === 'function') el.click();
    else fireMouse('click', 1, 0);

    if (isDouble) {
      fireMouse('pointerdown', 2, buttonsMask);
      fireMouse('mousedown', 2, buttonsMask);
      fireMouse('pointerup', 2, 0);
      fireMouse('mouseup', 2, 0);
      if (typeof el.click === 'function') el.click();
      fireMouse('dblclick', 2, 0);
    }
  }

  if (isLegacyString) return { ok: true };

  const rawText = String(
    (el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.textContent || ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  return {
    ok: true,
    clicked: true,
    ...(usedRef ? { ref: usedRef } : {}),
    tag: String(el.tagName || '').toLowerCase(),
    ...(rawText ? { text: rawText.slice(0, 120) } : {}),
    x: clientX,
    y: clientY,
  };
}

/**
 * Metin girilebilir bir alana (`input`, `textarea`, `contenteditable`) yazar; şifre ve ödeme
 * kartı alanlarını reddeder. React 15/16+ `_valueTracker` sıfırlaması ve native prototype setter
 * kullanır. Hem eski `typeRef(ref, text, submit)` hem de yeni
 * `typeRef({ ref, text, clear, submit })` çağrısını destekler.
 * @param {string | { ref: string, text: string, clear?: boolean, submit?: boolean }} refOrOptions
 * @param {string} [textArg]
 * @param {boolean} [submitArg]
 * @param {Document} [doc]
 */
export function typeRef(refOrOptions, textArg, submitArg, doc = document) {
  const isLegacyCall = typeof refOrOptions === 'string';
  const opts = isLegacyCall
    ? { ref: refOrOptions, text: String(textArg ?? ''), clear: true, submit: submitArg === true }
    : refOrOptions || {};
  const { ref, text = '' } = opts;
  const clear = opts.clear !== false;
  const submit = opts.submit === true;

  const store = globalThis.__orkestraRefs;
  const weak = store && typeof store.get === 'function' ? store.get(ref) : undefined;
  const el = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
  if (!el || el.isConnected === false) return { ok: false, code: 'no_such_element' };

  const tag = String(el.tagName || '').toLowerCase();
  const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  const tokens = String((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const cardName =
    /card.?(number|num|no)\b|\bcc.?(num|number|csc|cvc|cvv|exp)|\bcvv\b|\bcvc\b|security.?code/i;
  if (
    type === 'password' ||
    cardName.test(
      `${(el.getAttribute && el.getAttribute('name')) || ''} ${(el.getAttribute && el.getAttribute('id')) || ''}`
    ) ||
    tokens.some((t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password')
  ) {
    return { ok: false, code: 'forbidden_field' };
  }

  const ceAttr = el.getAttribute ? el.getAttribute('contenteditable') : null;
  const isContentEditable =
    el.isContentEditable === true ||
    (ceAttr !== null && ['true', '', 'plaintext-only'].includes(ceAttr.toLowerCase()));

  const textTypes = ['', 'text', 'search', 'email', 'url', 'tel', 'number'];
  const isTextInput = (tag === 'input' && textTypes.includes(type)) || tag === 'textarea';

  if (!isTextInput && !isContentEditable) {
    return { ok: false, code: 'failed', message: 'The element does not accept typed text.' };
  }
  if (
    el.disabled === true ||
    el.readOnly === true ||
    (el.getAttribute && el.getAttribute('aria-disabled') === 'true')
  ) {
    return { ok: false, code: 'failed', message: 'The field is disabled or read-only.' };
  }

  if (typeof el.focus === 'function') el.focus();
  const win = (el.ownerDocument && el.ownerDocument.defaultView) || (doc && doc.defaultView) || globalThis;
  const emitFullKeyboard = !isLegacyCall || Boolean(el.ownerDocument);

  const makeKeyEvent = (eventType, key, code, keyCode) => {
    const KeyCtor = (win && win.KeyboardEvent) || globalThis.KeyboardEvent;
    if (typeof KeyCtor === 'function') {
      return new KeyCtor(eventType, {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });
    }
    return new Event(eventType, { bubbles: true, cancelable: true });
  };

  const makeInputEvent = (eventType, dataValue) => {
    const InputCtor = (win && win.InputEvent) || globalThis.InputEvent;
    if (typeof InputCtor === 'function') {
      return new InputCtor(eventType, {
        bubbles: true,
        cancelable: eventType === 'beforeinput',
        data: dataValue,
        inputType: 'insertText',
      });
    }
    return new Event(eventType, { bubbles: true, cancelable: eventType === 'beforeinput' });
  };

  let finalValue = '';
  if (isContentEditable && !isTextInput) {
    const prev = String(el.innerText ?? el.textContent ?? '');
    finalValue = clear ? text : prev + text;
    if (emitFullKeyboard) {
      el.dispatchEvent(makeKeyEvent('keydown', 'Unidentified', '', 229));
      el.dispatchEvent(makeInputEvent('beforeinput', text));
    }
    el.textContent = finalValue;
    if ('innerText' in el) el.innerText = finalValue;
    el.dispatchEvent(makeInputEvent('input', text));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (emitFullKeyboard) {
      el.dispatchEvent(makeKeyEvent('keyup', 'Unidentified', '', 229));
    }
  } else {
    const previousValue = String(el.value ?? '');
    finalValue = clear ? text : previousValue + text;
    if (emitFullKeyboard) {
      el.dispatchEvent(makeKeyEvent('keydown', 'Unidentified', '', 229));
      el.dispatchEvent(makeInputEvent('beforeinput', text));
    }
    // React 15/16+ _valueTracker sıfırlaması: React önceki değeri farklı görsün ve onChange tetiklesin.
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(previousValue);
    }
    const proto =
      tag === 'textarea'
        ? (win && win.HTMLTextAreaElement) || globalThis.HTMLTextAreaElement
        : (win && win.HTMLInputElement) || globalThis.HTMLInputElement;
    const descriptor = proto && proto.prototype
      ? Object.getOwnPropertyDescriptor(proto.prototype, 'value')
      : undefined;
    if (descriptor && typeof descriptor.set === 'function') {
      try {
        descriptor.set.call(el, finalValue);
      } catch {
        el.value = finalValue;
      }
    } else {
      el.value = finalValue;
    }
    // Sahte DOM nesnelerinde native prototype setter `el.value`'yu güncellemediyse doğrudan ata.
    if (el.value !== finalValue) {
      el.value = finalValue;
    }
    el.dispatchEvent(emitFullKeyboard ? makeInputEvent('input', text) : new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (emitFullKeyboard) {
      el.dispatchEvent(makeKeyEvent('keyup', 'Unidentified', '', 229));
    }
  }

  if (submit) {
    if (emitFullKeyboard) {
      el.dispatchEvent(makeKeyEvent('keydown', 'Enter', 'Enter', 13));
      el.dispatchEvent(makeKeyEvent('keyup', 'Enter', 'Enter', 13));
    }
    if (el.form) {
      if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else if (typeof el.form.submit === 'function') el.form.submit();
    }
  }

  if (isLegacyCall) return { ok: true };
  return { ok: true, typed: true, ref, value: finalValue };
}

/**
 * `select`, `checkbox`, `radio`, `range`, `date`, `input`, `textarea` elemanlarına
 * React/Vue uyumlu doğrudan değer atar.
 * @param {{ ref: string, value: string | boolean | number }} options
 * @param {Document} [doc]
 */
export function formInputRef(options, doc = document) {
  const { ref, value } = options || {};
  const store = globalThis.__orkestraRefs;
  const weak = store && typeof store.get === 'function' ? store.get(ref) : undefined;
  const el = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
  if (!el || el.isConnected === false) return { ok: false, code: 'no_such_element' };

  const tag = String(el.tagName || '').toLowerCase();
  const type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  const tokens = String((el.getAttribute && el.getAttribute('autocomplete')) || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const cardName =
    /card.?(number|num|no)\b|\bcc.?(num|number|csc|cvc|cvv|exp)|\bcvv\b|\bcvc\b|security.?code/i;
  if (
    type === 'password' ||
    cardName.test(
      `${(el.getAttribute && el.getAttribute('name')) || ''} ${(el.getAttribute && el.getAttribute('id')) || ''}`
    ) ||
    tokens.some((t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password')
  ) {
    return { ok: false, code: 'forbidden_field' };
  }

  if (el.disabled === true || el.readOnly === true) {
    return { ok: false, code: 'failed', message: 'The field is disabled or read-only.' };
  }

  if (typeof el.focus === 'function') el.focus();
  const win = (el.ownerDocument && el.ownerDocument.defaultView) || (doc && doc.defaultView) || globalThis;
  const tracker = el._valueTracker;

  if (tag === 'select') {
    const previousValue = String(el.value ?? '');
    const wanted = String(value);
    const optionsList = el.options ? Array.from(el.options) : [];
    let chosenValue = wanted;
    if (optionsList.length > 0) {
      const matched =
        optionsList.find((o) => o.value === wanted) ||
        optionsList.find((o) => String(o.textContent || o.label || '').trim() === wanted.trim()) ||
        optionsList.find((o) => String(o.value || '').toLowerCase() === wanted.toLowerCase()) ||
        optionsList.find(
          (o) =>
            String(o.textContent || o.label || '')
              .trim()
              .toLowerCase() === wanted.trim().toLowerCase()
        );
      if (!matched) {
        return {
          ok: false,
          code: 'failed',
          message: `Option "${wanted}" not found in <select>.`,
        };
      }
      if (matched.disabled) {
        return { ok: false, code: 'failed', message: `Option "${wanted}" is disabled.` };
      }
      for (const opt of optionsList) opt.selected = opt === matched;
      chosenValue = matched.value;
    }
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(previousValue);
    }
    const SelectProto = (win && win.HTMLSelectElement) || globalThis.HTMLSelectElement;
    const setter =
      SelectProto && SelectProto.prototype
        ? Object.getOwnPropertyDescriptor(SelectProto.prototype, 'value')
        : undefined;
    if (setter && typeof setter.set === 'function') {
      try {
        setter.set.call(el, chosenValue);
      } catch {
        el.value = chosenValue;
      }
    } else {
      el.value = chosenValue;
    }
    if (el.value !== chosenValue) el.value = chosenValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, updated: true, ref, tag, value: el.value };
  }

  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    const prevChecked = Boolean(el.checked);
    const nextChecked =
      typeof value === 'boolean'
        ? value
        : ['true', '1', 'yes', 'on', 'checked'].includes(String(value).toLowerCase());
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(String(prevChecked));
    }
    const InputProto = (win && win.HTMLInputElement) || globalThis.HTMLInputElement;
    const setter =
      InputProto && InputProto.prototype
        ? Object.getOwnPropertyDescriptor(InputProto.prototype, 'checked')
        : undefined;
    if (setter && typeof setter.set === 'function') {
      try {
        setter.set.call(el, nextChecked);
      } catch {
        el.checked = nextChecked;
      }
    } else {
      el.checked = nextChecked;
    }
    if (el.checked !== nextChecked) el.checked = nextChecked;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, updated: true, ref, tag, value: Boolean(el.checked) };
  }

  if (tag === 'input' || tag === 'textarea') {
    if (type === 'file') {
      return { ok: false, code: 'failed', message: 'File inputs cannot be set via form_input.' };
    }
    const previousValue = String(el.value ?? '');
    const nextValue = String(value);
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(previousValue);
    }
    const Proto =
      tag === 'textarea'
        ? (win && win.HTMLTextAreaElement) || globalThis.HTMLTextAreaElement
        : (win && win.HTMLInputElement) || globalThis.HTMLInputElement;
    const setter =
      Proto && Proto.prototype
        ? Object.getOwnPropertyDescriptor(Proto.prototype, 'value')
        : undefined;
    if (setter && typeof setter.set === 'function') {
      try {
        setter.set.call(el, nextValue);
      } catch {
        el.value = nextValue;
      }
    } else {
      el.value = nextValue;
    }
    if (el.value !== nextValue) el.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, updated: true, ref, tag, value: el.value };
  }

  const ceAttr = el.getAttribute ? el.getAttribute('contenteditable') : null;
  if (
    el.isContentEditable === true ||
    (ceAttr !== null && ceAttr.toLowerCase() !== 'false')
  ) {
    const nextValue = String(value);
    el.textContent = nextValue;
    if ('innerText' in el) el.innerText = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, updated: true, ref, tag, value: nextValue };
  }

  return { ok: false, code: 'failed', message: `Element <${tag}> is not a supported form input.` };
}

/**
 * Aktif öğeye veya `ref` ile belirtilen öğeye klavye tuşu / kombinasyonu (`Enter`, `Tab`,
 * `Escape`, `ArrowDown`, `Meta+a` vb.) gönderir.
 * @param {{ key: string, ref?: string, modifiers?: string[] }} options
 * @param {Document} [doc]
 */
export function pressKeyInPage(options, doc = document) {
  const { key: rawKey, ref, modifiers = [] } = options || {};
  let target = null;
  if (typeof ref === 'string') {
    const store = globalThis.__orkestraRefs;
    const weak = store && typeof store.get === 'function' ? store.get(ref) : undefined;
    target = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
    if (!target || target.isConnected === false) return { ok: false, code: 'no_such_element' };
    if (typeof target.focus === 'function') target.focus();
  } else {
    target = doc.activeElement || doc.body || doc.documentElement;
  }

  let altKey = false;
  let ctrlKey = false;
  let metaKey = false;
  let shiftKey = false;

  const applyModifier = (mod) => {
    const lower = String(mod).trim().toLowerCase();
    if (lower === 'alt' || lower === 'option') altKey = true;
    else if (lower === 'control' || lower === 'ctrl') ctrlKey = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super')
      metaKey = true;
    else if (lower === 'shift') shiftKey = true;
  };

  for (const mod of modifiers) applyModifier(mod);

  let mainKey = String(rawKey || '').trim();
  if (mainKey.includes('+') && mainKey.length > 1) {
    const parts = mainKey.split('+').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) applyModifier(parts[i]);
    mainKey = parts[parts.length - 1];
  }

  const aliases = {
    esc: 'Escape',
    escape: 'Escape',
    return: 'Enter',
    enter: 'Enter',
    tab: 'Tab',
    space: ' ',
    spacebar: ' ',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    up: 'ArrowUp',
    arrowup: 'ArrowUp',
    down: 'ArrowDown',
    arrowdown: 'ArrowDown',
    left: 'ArrowLeft',
    arrowleft: 'ArrowLeft',
    right: 'ArrowRight',
    arrowright: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };
  const normalizedKey = aliases[mainKey.toLowerCase()] || mainKey;

  const keyCodes = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ' ': 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  };
  const keyCode =
    keyCodes[normalizedKey] ||
    (normalizedKey.length === 1 ? normalizedKey.toUpperCase().charCodeAt(0) : 0);
  const code =
    normalizedKey === ' '
      ? 'Space'
      : normalizedKey.length === 1 && /[a-zA-Z]/.test(normalizedKey)
        ? `Key${normalizedKey.toUpperCase()}`
        : normalizedKey.length === 1 && /[0-9]/.test(normalizedKey)
          ? `Digit${normalizedKey}`
          : normalizedKey;

  const win =
    (target && target.ownerDocument && target.ownerDocument.defaultView) ||
    (doc && doc.defaultView) ||
    globalThis;
  const KeyCtor = (win && win.KeyboardEvent) || globalThis.KeyboardEvent;

  const fire = (type) => {
    if (!target || typeof target.dispatchEvent !== 'function') return true;
    const keyProps = {
      key: normalizedKey,
      code,
      keyCode,
      which: keyCode,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
    };
    const ev =
      typeof KeyCtor === 'function'
        ? new KeyCtor(type, { ...keyProps, bubbles: true, cancelable: true })
        : Object.assign(new Event(type, { bubbles: true, cancelable: true }), keyProps);
    return target.dispatchEvent(ev);
  };

  const notCancelled = fire('keydown');
  if (normalizedKey === 'Enter' || normalizedKey.length === 1) {
    fire('keypress');
  }
  fire('keyup');

  if (notCancelled && target) {
    const tag = String(target.tagName || '').toLowerCase();
    if (
      normalizedKey === 'Enter' &&
      !ctrlKey &&
      !metaKey &&
      !altKey &&
      tag === 'input' &&
      target.form
    ) {
      if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit();
      else if (typeof target.form.submit === 'function') target.form.submit();
    } else if (
      (metaKey || ctrlKey) &&
      normalizedKey.toLowerCase() === 'a' &&
      typeof target.select === 'function'
    ) {
      target.select();
    }
  }

  return { ok: true, pressed: true, key: String(rawKey) };
}

/**
 * Sayfayı veya bir kapsayıcıyı (`ref`) belirtilen yönde kaydırır ya da `toRef` öğesini görünür
 * alana getirir.
 * @param {{ direction?: 'up' | 'down' | 'left' | 'right', amount?: number, ref?: string, toRef?: string }} [options]
 * @param {Document} [doc]
 */
export function scrollPage(options = {}, doc = document) {
  const win = (doc && doc.defaultView) || globalThis;
  const store = globalThis.__orkestraRefs;

  if (typeof options.toRef === 'string') {
    const weak = store && typeof store.get === 'function' ? store.get(options.toRef) : undefined;
    const target = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
    if (!target || target.isConnected === false) return { ok: false, code: 'no_such_element' };
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    const scroller = doc.scrollingElement || doc.documentElement || doc.body;
    return {
      ok: true,
      scrolled: true,
      scrollX: Math.round(Number(win.scrollX ?? (scroller && scroller.scrollLeft) ?? 0)),
      scrollY: Math.round(Number(win.scrollY ?? (scroller && scroller.scrollTop) ?? 0)),
    };
  }

  const direction = options.direction || 'down';
  const amount = Math.abs(Number(options.amount) || 500);
  const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;

  let container = null;
  if (typeof options.ref === 'string') {
    const weak = store && typeof store.get === 'function' ? store.get(options.ref) : undefined;
    container = weak && typeof weak.deref === 'function' ? weak.deref() : undefined;
    if (!container || container.isConnected === false) {
      return { ok: false, code: 'no_such_element' };
    }
  }

  if (container) {
    if (typeof container.scrollBy === 'function') {
      container.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    } else {
      container.scrollLeft = Number(container.scrollLeft || 0) + dx;
      container.scrollTop = Number(container.scrollTop || 0) + dy;
    }
    return {
      ok: true,
      scrolled: true,
      scrollX: Math.round(Number(container.scrollLeft || 0)),
      scrollY: Math.round(Number(container.scrollTop || 0)),
    };
  }

  const scroller = doc.scrollingElement || doc.documentElement || doc.body;
  if (win && typeof win.scrollBy === 'function') {
    win.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  } else if (scroller && typeof scroller.scrollBy === 'function') {
    scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  } else if (scroller) {
    scroller.scrollLeft = Number(scroller.scrollLeft || 0) + dx;
    scroller.scrollTop = Number(scroller.scrollTop || 0) + dy;
  }

  return {
    ok: true,
    scrolled: true,
    scrollX: Math.round(Number(win.scrollX ?? (scroller && scroller.scrollLeft) ?? 0)),
    scrollY: Math.round(Number(win.scrollY ?? (scroller && scroller.scrollTop) ?? 0)),
  };
}

/**
 * Sayfanın MAIN world bağlamında JavaScript ifadesi çalıştırır, Promise sonuçlarını bekler
 * ve döngüsel referans / DOM düğümü güvenli JSON serileştirmesi yapar.
 * @param {string} expression
 * @param {any} [win]
 */
export async function evaluateInPage(expression, win = globalThis) {
  function safeSerialize(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : String(value);
    if (t === 'bigint') return String(value);
    if (t === 'symbol') return String(value);
    if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (t === 'object') {
      if (value === win || (win && value === win.window)) return '[Window]';
      if (win && value === win.document) return '[Document]';
      if (typeof value.nodeType === 'number' && typeof value.nodeName === 'string') {
        return {
          nodeType: value.nodeType,
          tag: String(value.tagName || value.nodeName).toLowerCase(),
          ...(value.id ? { id: value.id } : {}),
          ...(typeof value.className === 'string' && value.className
            ? { className: value.className }
            : {}),
          text: String(value.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200),
        };
      }
      if (seen.has(value)) return '[Circular]';
      if (depth >= 6) return '[Object]';
      seen.add(value);
      if (Array.isArray(value)) {
        return value.slice(0, 200).map((item) => safeSerialize(item, depth + 1, seen));
      }
      if (value instanceof Map) {
        const out = {};
        let count = 0;
        for (const [k, v] of value.entries()) {
          if (count++ >= 100) break;
          out[String(k)] = safeSerialize(v, depth + 1, seen);
        }
        return out;
      }
      if (value instanceof Set) {
        return Array.from(value)
          .slice(0, 200)
          .map((item) => safeSerialize(item, depth + 1, seen));
      }
      const out = {};
      const keys = Object.keys(value).slice(0, 100);
      for (const k of keys) {
        try {
          out[k] = safeSerialize(value[k], depth + 1, seen);
        } catch {
          out[k] = '[Unreadable]';
        }
      }
      return out;
    }
    return String(value);
  }

  try {
    let rawResult;
    const evalFn = (win && win.eval) || eval;
    try {
      rawResult = evalFn(expression);
    } catch (syntaxErr) {
      // Çok satırlı return veya await ifadeleri için AsyncFunction sarmalayıcısı dene
      if (syntaxErr instanceof SyntaxError) {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction(expression);
        rawResult = await fn();
      } else {
        throw syntaxErr;
      }
    }
    if (rawResult && (typeof rawResult === 'object' || typeof rawResult === 'function')) {
      if (typeof rawResult.then === 'function') {
        rawResult = await rawResult;
      }
    }
    const type =
      rawResult === null
        ? 'null'
        : Array.isArray(rawResult)
          ? 'array'
          : typeof rawResult;
    return {
      ok: true,
      result: safeSerialize(rawResult),
      type,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `wait_for` için sayfadaki metin veya seçici koşullarının sağlanıp sağlanmadığını kontrol eder.
 * @param {{ text?: string, textGone?: string, selector?: string, selectorGone?: string }} [options]
 * @param {Document} [doc]
 */
export function checkWaitCondition(options = {}, doc = document) {
  const win = (doc && doc.defaultView) || globalThis;
  const visible = (el) => {
    if (!el || el.isConnected === false) return false;
    if (typeof el.closest === 'function' && el.closest('[data-orkestra-overlay]')) return false;
    if (win && typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  };

  const root = doc.body || doc.documentElement;
  const pageText = String((root && (root.innerText ?? root.textContent)) || '').toLowerCase();

  if (typeof options.text === 'string' && options.text.length > 0) {
    if (!pageText.includes(options.text.toLowerCase())) {
      return { ok: true, matched: false };
    }
  }
  if (typeof options.textGone === 'string' && options.textGone.length > 0) {
    if (pageText.includes(options.textGone.toLowerCase())) {
      return { ok: true, matched: false };
    }
  }
  if (typeof options.selector === 'string' && options.selector.trim() !== '') {
    let el = null;
    try {
      el = doc.querySelector(options.selector);
    } catch {
      return { ok: false, code: 'failed', message: `Invalid CSS selector: ${options.selector}` };
    }
    if (!el || !visible(el)) return { ok: true, matched: false };
  }
  if (typeof options.selectorGone === 'string' && options.selectorGone.trim() !== '') {
    let el = null;
    try {
      el = doc.querySelector(options.selectorGone);
    } catch {
      return {
        ok: false,
        code: 'failed',
        message: `Invalid CSS selector: ${options.selectorGone}`,
      };
    }
    if (el && visible(el)) return { ok: true, matched: false };
  }

  return { ok: true, matched: true };
}

/**
 * Sayfanın MAIN world konsol tamponunu (`window.__orkestraMonitor.console`) okur; kanca
 * henüz kurulmamışsa anında kurar.
 * @param {{ level?: 'all' | 'log' | 'info' | 'warn' | 'error', limit?: number, clear?: boolean }} [options]
 * @param {any} [win]
 */
export function readConsolePage(options = {}, win = globalThis) {
  if (typeof win.__orkestraInstallMonitor === 'function') {
    win.__orkestraInstallMonitor(win);
  } else if (!win.__orkestraMonitor) {
    const state = {
      installed: true,
      console: [],
      network: [],
      seenResourceCount: 0,
      clearedAtPerfTime: 0,
    };
    const consoleObj = win.console;
    if (consoleObj && typeof consoleObj === 'object') {
      for (const lvl of ['log', 'info', 'warn', 'error']) {
        const orig = consoleObj[lvl];
        if (typeof orig !== 'function') continue;
        try {
          consoleObj[lvl] = function (...args) {
            try {
              const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
              state.console.push({ level: lvl, text, message: text, timestamp: Date.now() });
              if (state.console.length > 200) state.console.splice(0, state.console.length - 200);
            } catch {
              // Yoksay
            }
            return orig.apply(this, args);
          };
        } catch {
          // Yoksay
        }
      }
    }
    win.__orkestraMonitor = state;
  }

  const monitor = win.__orkestraMonitor || { console: [] };
  const allEntries = Array.isArray(monitor.console) ? monitor.console : [];
  const level = options.level || 'all';
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
  const filtered =
    level === 'all' ? allEntries.slice() : allEntries.filter((item) => item.level === level);
  const entries = filtered.slice(-limit);
  if (options.clear === true && Array.isArray(monitor.console)) {
    monitor.console.length = 0;
  }
  return { ok: true, entries };
}

/**
 * Sayfanın MAIN world ağ tamponunu (`window.__orkestraMonitor.network`) ve mevcut
 * `performance.getEntriesByType('resource')` kayıtlarını okur; kanca yoksa kurar.
 * @param {{ urlFilter?: string, method?: string, status?: number, limit?: number, clear?: boolean }} [options]
 * @param {any} [win]
 */
export function readNetworkPage(options = {}, win = globalThis) {
  if (typeof win.__orkestraInstallMonitor === 'function') {
    win.__orkestraInstallMonitor(win);
  } else if (!win.__orkestraMonitor) {
    win.__orkestraMonitor = {
      installed: true,
      console: [],
      network: [],
      seenResourceCount: 0,
      clearedAtPerfTime: 0,
    };
  }

  const monitor = win.__orkestraMonitor;
  if (typeof monitor.syncPerformanceResources === 'function') {
    monitor.syncPerformanceResources();
  } else if (win.performance && typeof win.performance.getEntriesByType === 'function') {
    try {
      const resources = win.performance.getEntriesByType('resource') || [];
      const seenStart = Number(monitor.seenResourceCount) || 0;
      for (let i = seenStart; i < resources.length; i += 1) {
        const r = resources[i];
        if (!r || typeof r.name !== 'string') continue;
        const durationMs =
          typeof r.duration === 'number' && Number.isFinite(r.duration)
            ? Math.max(0, Math.round(r.duration))
            : 0;
        const status =
          typeof r.responseStatus === 'number' && r.responseStatus > 0 ? r.responseStatus : 200;
        monitor.network.push({
          url: r.name,
          method: 'GET',
          status,
          ok: status >= 200 && status < 400,
          type: String(r.initiatorType || 'resource').toLowerCase(),
          durationMs,
          duration: durationMs,
          timestamp: Date.now(),
        });
      }
      monitor.seenResourceCount = resources.length;
    } catch {
      // Yoksay
    }
  }

  const allRequests = Array.isArray(monitor.network) ? monitor.network : [];
  const urlFilter =
    typeof options.urlFilter === 'string' ? options.urlFilter.trim().toLowerCase() : '';
  const methodFilter =
    typeof options.method === 'string' ? options.method.trim().toUpperCase() : '';
  const statusFilter = typeof options.status === 'number' ? options.status : undefined;
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));

  const filtered = allRequests.filter((req) => {
    if (urlFilter && !String(req.url || '').toLowerCase().includes(urlFilter)) return false;
    if (methodFilter && String(req.method || 'GET').toUpperCase() !== methodFilter) return false;
    if (statusFilter !== undefined && Number(req.status) !== statusFilter) return false;
    return true;
  });

  const requests = filtered.slice(-limit);
  if (options.clear === true && Array.isArray(monitor.network)) {
    monitor.network.length = 0;
    if (win.performance && typeof win.performance.now === 'function') {
      monitor.clearedAtPerfTime = win.performance.now();
    }
    if (win.performance && typeof win.performance.getEntriesByType === 'function') {
      try {
        monitor.seenResourceCount = (win.performance.getEntriesByType('resource') || []).length;
      } catch {
        // Yoksay
      }
    }
  }
  return { ok: true, requests };
}
