// `chrome.scripting.executeScript({ func })` ile sayfaya enjekte edilen SABİT fonksiyonlar.
// Her fonksiyon kendi içinde tamdır (dış kapsama başvurmaz; Chrome yalnızca kaynağını taşır) ve
// ajan verisi betik kaynağına değil yalnızca `args` ile girer. Sayfada rastgele JavaScript
// çalıştıran bir yol yoktur. İkinci parametre (`doc`) yalnızca testlerde sahte belge vermek içindir;
// enjeksiyonda hiç verilmez ve gerçek `document` kullanılır.

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="option"]',
].join(',');

/**
 * Görünür metni ve etkileşimli öğeleri (ref_N) döndürür. Şifre ve kart alanları listelenir ama
 * değerleri asla okunmaz. Başvurular sayfa DOM'una yazılmaz; uzantının yalıtılmış dünyasında
 * zayıf referanslarla tutulur.
 * @param {number} maxChars
 * @param {Document} [doc]
 */
export function snapshotPage(maxChars, doc = document) {
  const win = doc.defaultView;
  const forbidden = (el) => {
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.some((t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password');
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  const store = new Map();
  const elements = [];
  const nodes = doc.querySelectorAll(INTERACTIVE_SELECTOR);
  for (const el of nodes) {
    if (elements.length >= 400) break;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || !visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const isForbidden = forbidden(el);
    const ref = `ref_${elements.length + 1}`;
    store.set(ref, new WeakRef(el));
    const label =
      el.getAttribute('aria-label') ||
      (el.labels && el.labels[0] ? el.labels[0].textContent : '') ||
      el.getAttribute('placeholder') ||
      el.textContent ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      '';
    const entry = {
      ref,
      tag,
      role: el.getAttribute('role') || undefined,
      type: type || undefined,
      name: clip(label, 120),
      disabled: el.disabled === true ? true : undefined,
      forbidden: isForbidden ? true : undefined,
    };
    if (tag === 'a') entry.href = clip(el.getAttribute('href'), 200);
    if (!isForbidden && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      if (type === 'checkbox' || type === 'radio') entry.checked = el.checked === true;
      else entry.value = clip(el.value, 120);
    }
    elements.push(entry);
  }
  globalThis.__orkestraRefs = store;

  const body = doc.body;
  let text = body ? String(body.innerText || '') : '';
  const limit = Math.max(1, Math.min(Number(maxChars) || 20000, 200000));
  const truncated = text.length > limit;
  if (truncated) text = text.slice(0, limit);
  return {
    url: String(doc.location && doc.location.href),
    title: String(doc.title || ''),
    text,
    truncated,
    elements,
  };
}

/**
 * Son görüntüdeki bir öğeyi tıklar.
 * @param {string} ref
 * @param {Document} [doc]
 */
export function clickRef(ref, doc = document) {
  const store = globalThis.__orkestraRefs;
  const el = store && store.get(ref) ? store.get(ref).deref() : undefined;
  if (!el || !el.isConnected) return { ok: false, code: 'no_such_element' };
  if (el.disabled === true) return { ok: false, code: 'failed', message: 'The element is disabled.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true };
}

/**
 * Metin girilebilir bir alana yazar; şifre ve ödeme kartı alanlarını reddeder. Kontrol yazma
 * anında, öğenin güncel özniteliklerine bakarak yapılır.
 * @param {string} ref
 * @param {string} text
 * @param {boolean} submit
 * @param {Document} [doc]
 */
export function typeRef(ref, text, submit, doc = document) {
  const store = globalThis.__orkestraRefs;
  const el = store && store.get(ref) ? store.get(ref).deref() : undefined;
  if (!el || !el.isConnected) return { ok: false, code: 'no_such_element' };
  const tag = el.tagName.toLowerCase();
  const type = String(el.getAttribute('type') || '').toLowerCase();
  const tokens = String(el.getAttribute('autocomplete') || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (
    type === 'password' ||
    tokens.some((t) => t.startsWith('cc-') || t === 'current-password' || t === 'new-password')
  ) {
    return { ok: false, code: 'forbidden_field' };
  }
  const textTypes = ['', 'text', 'search', 'email', 'url', 'tel', 'number'];
  if (!((tag === 'input' && textTypes.includes(type)) || tag === 'textarea')) {
    return { ok: false, code: 'failed', message: 'The element does not accept typed text.' };
  }
  if (el.disabled === true || el.readOnly === true) {
    return { ok: false, code: 'failed', message: 'The field is disabled or read-only.' };
  }
  el.focus();
  const proto = tag === 'textarea' ? globalThis.HTMLTextAreaElement : globalThis.HTMLInputElement;
  const setter = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit === true && el.form && typeof el.form.requestSubmit === 'function') {
    el.form.requestSubmit();
  }
  return { ok: true };
}
