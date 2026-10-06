import type {
  PageDocument,
  PageElement,
  PageEvent,
  PageNode,
  PageOption,
  PageRect,
  PageStyle,
  PageWindow,
} from './page-dom';

/**
 * Sekme sayfasına izole bir dünyada (isolated world) enjekte edilen ajan betiği.
 *
 * `pageAgent` kendi kendine yeterli düz bir fonksiyondur: kaynağı
 * `Function.prototype.toString()` ile alınıp `(kaynak)(window, sürüm, komut)` biçiminde
 * çalıştırılır. Bu yüzden gövdesi modül kapsamındaki hiçbir çalışma zamanı değerine
 * (import, sabit, yardımcı) başvuramaz; yalnızca tipler kullanılabilir. Durum (öğe
 * referansları) izole dünyanın global nesnesinde belge ömrü boyunca saklanır; yeni belge
 * yeni bir dünya bağlamı demektir ve durum kendiliğinden sıfırlanır.
 */

export const PAGE_AGENT_VERSION = 'orkestra-page-agent/1';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type PageTarget = { ref: string } | { x: number; y: number };

/** Görünür alan (visual viewport) koordinatı, CSS piksel. */
export type PagePoint = { x: number; y: number };

export type ScrollPosition = { x: number; y: number; windowX: number; windowY: number };

export type EditState = {
  kind: 'input' | 'textarea' | 'contenteditable' | 'other' | 'none';
  label: string;
  empty: boolean;
  allSelected: boolean;
};

export type PageMetrics = {
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  contentWidth: number;
  contentHeight: number;
  devicePixelRatio: number;
};

/** Ek girdi almayan komutlar (yalnızca `kind`). */
type EmptyInput = { readonly noInput?: never };

export type PageCommandMap = {
  snapshot: {
    input: { maxChars: number; resetRefs: boolean; refStart: number };
    output: { url: string; title: string; outline: string; truncated: boolean; nextRef: number };
  };
  locate: {
    input: { target: PageTarget; purpose: 'click' | 'hover'; scroll: boolean };
    output: { point: PagePoint; label: string };
  };
  prepareType: {
    input: { target: PageTarget };
    output: {
      focused: boolean;
      point: PagePoint | null;
      occlusion: string | null;
      mode: 'text' | 'value';
      label: string;
    };
  };
  focus: { input: { target: PageTarget }; output: { focused: boolean } };
  editState: { input: EmptyInput; output: EditState };
  caretToEnd: { input: EmptyInput; output: { moved: boolean } };
  forceClear: { input: EmptyInput; output: { empty: boolean } };
  setValue: { input: { target: PageTarget; value: string }; output: { value: string } };
  scrollProbe: {
    input: { target: PageTarget | null; direction: ScrollDirection };
    output: { point: PagePoint; position: ScrollPosition; defaultAmount: number };
  };
  scrollRead: { input: EmptyInput; output: { position: ScrollPosition } };
  scrollBy: {
    input: { direction: ScrollDirection; amount: number };
    output: { position: ScrollPosition };
  };
  selectOption: { input: { target: PageTarget; values: string[] }; output: { selected: string[] } };
  text: { input: { maxChars: number }; output: { text: string; truncated: boolean } };
  matchText: {
    input: { text: string | null; textGone: string | null };
    output: { textFound: boolean; textGoneAbsent: boolean };
  };
  metrics: { input: EmptyInput; output: PageMetrics };
  watchKey: { input: EmptyInput; output: { watching: boolean } };
  keyResult: { input: EmptyInput; output: { seen: boolean; defaultPrevented: boolean } };
};

export type PageCommandKind = keyof PageCommandMap;

export type PageCommand = {
  [K in PageCommandKind]: { kind: K } & PageCommandMap[K]['input'];
}[PageCommandKind];

export type PageCommandOf<K extends PageCommandKind> = { kind: K } & PageCommandMap[K]['input'];

export type PageOutput<K extends PageCommandKind> = PageCommandMap[K]['output'];

export type PageResult = { ok: true; value: unknown } | { ok: false; error: string };

type KeyWatch = { listener: (event: PageEvent) => void; event: PageEvent | null };

export type PageAgentState = {
  version: string;
  refs: Map<string, PageElement>;
  elementRefs: WeakMap<PageElement, string>;
  nextRef: number;
  scrollContainer: PageElement | null;
  keyWatch: KeyWatch | null;
};

export function pageAgent(win: PageWindow, version: string, command: PageCommand): PageResult {
  // Ajana dönen beklenen hatalar; mesajları olduğu gibi iletilir.
  class AgentError extends Error {}

  const NAME_MAX = 100;
  const TEXT_MAX = 240;
  const VALUE_MAX = 100;
  const OPTIONS_MAX = 20;
  const SKIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'head',
    'meta',
    'link',
    'base',
    'title',
    'datalist',
    'option',
    'optgroup',
    'param',
    'source',
    'track',
    'colgroup',
    'col',
    'caption',
    'legend',
    'math',
    'object',
    'embed',
  ]);
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const VALUE_INPUT_TYPES = new Set([
    'date',
    'time',
    'datetime-local',
    'month',
    'week',
    'color',
    'range',
  ]);
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);
  const ACTIONABLE_ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'slider',
    'spinbutton',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
  ]);
  const LEAF_ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'textbox',
    'searchbox',
    'combobox',
    'slider',
    'spinbutton',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
  ]);
  const CONTAINER_ROLES = new Set([
    'banner',
    'navigation',
    'main',
    'complementary',
    'contentinfo',
    'region',
    'search',
    'form',
    'dialog',
    'alertdialog',
    'alert',
    'status',
    'log',
    'table',
    'grid',
    'treegrid',
    'listbox',
    'menu',
    'menubar',
    'tablist',
    'tree',
    'radiogroup',
    'toolbar',
    'group',
  ]);
  const ACTIONABLE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="combobox"]',
  ].join(',');

  const host = win as PageWindow & { __orkestraPageAgent?: PageAgentState };
  let existing = host.__orkestraPageAgent;
  if (!existing || existing.version !== version) {
    existing = {
      version,
      refs: new Map(),
      elementRefs: new WeakMap(),
      nextRef: 1,
      scrollContainer: null,
      keyWatch: null,
    };
    host.__orkestraPageAgent = existing;
  }
  const state: PageAgentState = existing;
  const doc = win.document;

  // ---------------------------------------------------------------------------------------
  // Genel yardımcılar
  // ---------------------------------------------------------------------------------------

  function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
  }

  function quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function isElement(node: PageNode | null | undefined): node is PageElement {
    return !!node && node.nodeType === 1;
  }

  function viewOf(el: PageElement): PageWindow {
    return el.ownerDocument?.defaultView ?? win;
  }

  function styleOf(el: PageElement): PageStyle {
    return viewOf(el).getComputedStyle(el);
  }

  function inputType(el: PageElement): string {
    return (el.getAttribute('type') ?? el.type ?? 'text').toLowerCase() || 'text';
  }

  function isInlineDisplay(display: string): boolean {
    return display.startsWith('inline') || display === 'contents' || display.startsWith('ruby');
  }

  function rectsOf(el: PageElement): PageRect[] {
    return Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  }

  function hasArea(el: PageElement): boolean {
    return rectsOf(el).length > 0;
  }

  /** Öğe görsel olarak gizli mi (özel onay kutularındaki gibi opaklık 0 ya da 1px). */
  function isVisuallyHidden(el: PageElement): boolean {
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility !== 'visible') return true;
    if (parseFloat(style.opacity) === 0) return true;
    const rects = rectsOf(el);
    if (rects.length === 0) return true;
    return rects.every((rect) => rect.width * rect.height <= 4);
  }

  /** Sıfır genişlik/yükseklikli ve taşanı kırpan öğenin içeriği hiç görünmez. */
  function isClippedToNothing(el: PageElement, style: PageStyle): boolean {
    const rect = el.getBoundingClientRect();
    const clips = (value: string) => value === 'hidden' || value === 'clip';
    return (
      (rect.width === 0 && clips(style.overflowX)) || (rect.height === 0 && clips(style.overflowY))
    );
  }

  function parentOf(node: PageNode): PageNode | null {
    if (node.parentNode) return node.parentNode;
    const maybeRoot = node as PageNode & { host?: PageElement };
    return maybeRoot.host ?? null;
  }

  function composedContains(ancestor: PageNode, node: PageNode | null): boolean {
    for (let current: PageNode | null = node; current; current = parentOf(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function composedParentElement(el: PageElement): PageElement | null {
    if (el.parentElement) return el.parentElement;
    const parent = el.parentNode as (PageNode & { host?: PageElement }) | null;
    return parent && parent.host ? parent.host : null;
  }

  function deepActiveElement(root: PageDocument): PageElement | null {
    let active = root.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      if (active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      if (active.localName === 'iframe' || active.localName === 'frame') {
        const inner = frameDocument(active);
        if (inner && inner.activeElement && inner.activeElement !== inner.body) {
          active = inner.activeElement;
          continue;
        }
      }
      break;
    }
    return active;
  }

  function frameDocument(frame: PageElement): PageDocument | null {
    try {
      return frame.contentDocument ?? null;
    } catch {
      return null;
    }
  }

  function deepElementFromPoint(root: PageDocument, x: number, y: number): PageElement | null {
    let hit = root.elementFromPoint(x, y);
    for (let depth = 0; hit && hit.shadowRoot && depth < 32; depth++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function isFocusWithin(el: PageElement): boolean {
    const active = deepActiveElement(doc);
    return !!active && (active === el || composedContains(el, active));
  }

  function describeElement(el: PageElement): string {
    const ref = state.elementRefs.get(el);
    const id = el.id ? `#${el.id}` : '';
    const classes = normalize(el.getAttribute('class') ?? '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('');
    const text = truncate(normalize(el.innerText ?? el.textContent ?? ''), 40);
    return `<${el.localName}${id}${classes}>${text ? ` ${quote(text)}` : ''}${ref ? ` [ref=${ref}]` : ''}`;
  }

  function refFor(el: PageElement): string {
    let ref = state.elementRefs.get(el);
    if (!ref) {
      ref = `e${state.nextRef++}`;
      state.elementRefs.set(el, ref);
    }
    state.refs.set(ref, el);
    return ref;
  }

  function readScroll(container: PageElement | null): ScrollPosition {
    const target = container ?? doc.scrollingElement ?? doc.documentElement;
    return {
      x: target ? target.scrollLeft : win.scrollX,
      y: target ? target.scrollTop : win.scrollY,
      windowX: win.scrollX,
      windowY: win.scrollY,
    };
  }

  /** Düzen görünür alanı (layout viewport) noktasını görsel görünür alana çevirir. */
  function toVisualPoint(x: number, y: number): PagePoint {
    const viewport = win.visualViewport;
    if (!viewport || viewport.scale === 1) return { x, y };
    return {
      x: (x - viewport.offsetLeft) * viewport.scale,
      y: (y - viewport.offsetTop) * viewport.scale,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Roller ve erişilebilir adlar
  // ---------------------------------------------------------------------------------------

  function isEditingHost(el: PageElement): boolean {
    if (!el.isContentEditable) return false;
    const parent = composedParentElement(el);
    return !parent || !parent.isContentEditable;
  }

  function roleOf(el: PageElement): string {
    const explicit = normalize(el.getAttribute('role') ?? '')
      .split(' ')[0]
      ?.toLowerCase();
    if (explicit === 'presentation' || explicit === 'none') return '';
    if (explicit) return explicit;
    const tag = el.localName;
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'input': {
        const type = inputType(el);
        if (BUTTON_INPUT_TYPES.has(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return '';
        return 'textbox';
      }
      case 'textarea':
        return 'textbox';
      case 'select':
        return el.multiple || (el.size ?? 0) > 1 ? 'listbox' : 'combobox';
      case 'img':
        return el.getAttribute('alt') === '' ? '' : 'img';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'header':
        return el.closest('article, aside, main, nav, section') ? '' : 'banner';
      case 'footer':
        return el.closest('article, aside, main, nav, section') ? '' : 'contentinfo';
      case 'form':
        return 'form';
      case 'search':
        return 'search';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'dialog':
        return 'dialog';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'fieldset':
        return 'group';
      case 'summary':
        return 'summary';
      case 'progress':
        return 'progressbar';
      default:
        return isEditingHost(el) ? 'textbox' : '';
    }
  }

  function textById(el: PageElement, id: string): string {
    const root = el.getRootNode() as PageNode & {
      getElementById?: (value: string) => PageElement | null;
    };
    const target =
      (root.getElementById ? root.getElementById(id) : null) ??
      el.ownerDocument?.getElementById(id);
    if (!target) return '';
    return target.innerText ?? target.textContent ?? '';
  }

  function contentText(el: PageElement): string {
    const text = normalize(el.innerText ?? el.textContent ?? '');
    if (text) return text;
    const labelled = el.querySelector('img[alt]:not([alt=""]), [aria-label]');
    if (labelled) {
      return normalize(labelled.getAttribute('aria-label') ?? labelled.getAttribute('alt') ?? '');
    }
    return '';
  }

  function labelsText(el: PageElement): string {
    const labels = el.labels ? Array.from(el.labels) : [];
    return normalize(labels.map((label) => label.innerText ?? label.textContent ?? '').join(' '));
  }

  function nameOf(el: PageElement, role: string): string {
    const labelledBy = normalize(el.getAttribute('aria-labelledby') ?? '');
    if (labelledBy) {
      const text = normalize(
        labelledBy
          .split(' ')
          .map((id) => textById(el, id))
          .join(' ')
      );
      if (text) return truncate(text, NAME_MAX);
    }
    const ariaLabel = normalize(el.getAttribute('aria-label') ?? '');
    if (ariaLabel) return truncate(ariaLabel, NAME_MAX);
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = inputType(el);
      if (tag === 'input' && BUTTON_INPUT_TYPES.has(type)) {
        if (type === 'image')
          return truncate(normalize(el.getAttribute('alt') ?? '') || 'Submit', NAME_MAX);
        const fallback = type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
        return truncate(normalize(el.value ?? '') || fallback, NAME_MAX);
      }
      const fromLabels = labelsText(el);
      if (fromLabels) return truncate(fromLabels, NAME_MAX);
      return truncate(normalize(el.getAttribute('title') ?? ''), NAME_MAX);
    }
    if (tag === 'img' || tag === 'area') {
      return truncate(
        normalize(el.getAttribute('alt') ?? el.getAttribute('title') ?? ''),
        NAME_MAX
      );
    }
    if (tag === 'svg') {
      const title = el.querySelector('title');
      return truncate(normalize(title?.textContent ?? ''), NAME_MAX);
    }
    if (tag === 'iframe' || tag === 'frame') {
      return truncate(
        normalize(el.getAttribute('title') ?? el.getAttribute('name') ?? ''),
        NAME_MAX
      );
    }
    if (tag === 'table') {
      const caption = el.querySelector('caption');
      return truncate(normalize(caption?.textContent ?? ''), NAME_MAX);
    }
    if (tag === 'fieldset') {
      const legend = el.querySelector('legend');
      return truncate(normalize(legend?.textContent ?? ''), NAME_MAX);
    }
    if (role === 'dialog' || role === 'alertdialog') {
      const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      return truncate(normalize(heading?.textContent ?? ''), NAME_MAX);
    }
    if (CONTAINER_ROLES.has(role)) return '';
    const text = contentText(el);
    if (text) return truncate(text, NAME_MAX);
    return truncate(normalize(el.getAttribute('title') ?? ''), NAME_MAX);
  }

  function displayUrl(raw: string): string {
    const value = raw.trim();
    if (/^javascript:/i.test(value)) return 'javascript:…';
    try {
      const base = new URL(win.location.href);
      const url = new URL(value, base);
      if (url.origin === base.origin && url.origin !== 'null') {
        return truncate(`${url.pathname}${url.search}${url.hash}`, 150);
      }
      return truncate(url.href, 150);
    } catch {
      return truncate(value, 150);
    }
  }

  function optionLabel(option: PageOption): string {
    return normalize(option.label || option.text || option.value);
  }

  function isDisabled(el: PageElement): boolean {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  function isDropdownSelect(el: PageElement): boolean {
    return el.localName === 'select' && !el.multiple && (el.size ?? 0) <= 1;
  }

  function stateFlags(el: PageElement, control: PageElement, role: string): string[] {
    const flags: string[] = [];
    const checked = control.getAttribute('aria-checked');
    if (
      control.localName === 'input' &&
      (inputType(control) === 'checkbox' || inputType(control) === 'radio')
    ) {
      if (control.indeterminate) flags.push('[mixed]');
      else if (control.checked) flags.push('[checked]');
    } else if (checked === 'true') flags.push('[checked]');
    else if (checked === 'mixed') flags.push('[mixed]');
    if (control.getAttribute('aria-selected') === 'true') flags.push('[selected]');
    const pressed = control.getAttribute('aria-pressed');
    if (pressed === 'true') flags.push('[pressed]');
    else if (pressed === 'mixed') flags.push('[mixed]');
    const expanded = control.getAttribute('aria-expanded');
    if (expanded === 'true') flags.push('[expanded]');
    else if (expanded === 'false') flags.push('[collapsed]');
    if (role === 'summary') {
      const details = control.parentElement;
      if (details && details.localName === 'details')
        flags.push(details.open ? '[expanded]' : '[collapsed]');
    }
    const current = control.getAttribute('aria-current');
    if (current && current !== 'false') flags.push('[current]');
    if (control.getAttribute('aria-invalid') === 'true') flags.push('[invalid]');
    if (isDisabled(control)) flags.push('[disabled]');
    if (control.required === true || control.getAttribute('aria-required') === 'true') {
      flags.push('[required]');
    }
    if (
      (control.readOnly === true &&
        (control.localName === 'input' || control.localName === 'textarea')) ||
      control.getAttribute('aria-readonly') === 'true'
    ) {
      flags.push('[readonly]');
    }
    if (isFocusWithin(control) || isFocusWithin(el)) flags.push('[focused]');
    return flags;
  }

  /** Etkileşimli bir öğenin anlık görüntü satırı (girinti ve "- " öneki olmadan). */
  function actionableLine(el: PageElement, role: string, control: PageElement): string {
    const name = el === control ? nameOf(el, role) : truncate(contentText(el), NAME_MAX);
    const head = [role || 'clickable', name ? quote(name) : ''].filter(Boolean).join(' ');
    const attrs: string[] = [];
    const trailing: string[] = [];
    const tag = control.localName;
    if (tag === 'input') {
      const type = inputType(control);
      if (TEXT_INPUT_TYPES.has(type) || VALUE_INPUT_TYPES.has(type)) {
        if (type !== 'text' && type !== 'search') attrs.push(`type=${type}`);
        const value = control.value ?? '';
        if (value) {
          attrs.push(
            type === 'password'
              ? `value=(${value.length} characters, hidden)`
              : `value=${quote(truncate(value, VALUE_MAX))}`
          );
        }
        const placeholder = normalize(control.placeholder ?? '');
        if (placeholder) attrs.push(`placeholder=${quote(truncate(placeholder, VALUE_MAX))}`);
      } else if (type === 'file') {
        attrs.push('type=file');
      }
    } else if (tag === 'textarea') {
      attrs.push('[multiline]');
      const value = control.value ?? '';
      if (value) attrs.push(`value=${quote(truncate(normalize(value), VALUE_MAX))}`);
      const placeholder = normalize(control.placeholder ?? '');
      if (placeholder) attrs.push(`placeholder=${quote(truncate(placeholder, VALUE_MAX))}`);
    } else if (tag === 'select') {
      const options = control.options ? Array.from(control.options) : [];
      const selected = options.filter((option) => option.selected);
      if (control.multiple) {
        attrs.push('[multiple]');
        if (selected.length > 0) {
          attrs.push(
            `selected=[${selected.map((option) => quote(optionLabel(option))).join(', ')}]`
          );
        }
      } else if (selected[0]) {
        attrs.push(`value=${quote(truncate(optionLabel(selected[0]), VALUE_MAX))}`);
      }
      if (options.length > 0) {
        const shown = options
          .slice(0, OPTIONS_MAX)
          .map(
            (option) =>
              `${quote(truncate(optionLabel(option), 60))}${option.disabled ? ' (disabled)' : ''}`
          );
        const more =
          options.length > OPTIONS_MAX ? `, … (+${options.length - OPTIONS_MAX} more)` : '';
        trailing.push(`options: ${shown.join(', ')}${more}`);
      }
    } else if (isEditingHost(control)) {
      const value = normalize(control.innerText ?? '');
      if (value) attrs.push(`value=${quote(truncate(value, VALUE_MAX))}`);
    }
    const valueNow = control.getAttribute('aria-valuenow');
    if (valueNow && tag !== 'input') attrs.push(`value=${quote(truncate(valueNow, VALUE_MAX))}`);
    if (role === 'heading') {
      const level = /^h([1-6])$/.exec(control.localName)?.[1] ?? control.getAttribute('aria-level');
      if (level) attrs.push(`[level=${level}]`);
    }
    attrs.push(...stateFlags(el, control, role));
    attrs.push(`[ref=${refFor(el)}]`);
    if (el.localName === 'a' || el.localName === 'area') {
      const href = el.getAttribute('href');
      if (href !== null) trailing.push(`-> ${displayUrl(href)}`);
    }
    return [head, ...attrs, ...trailing].join(' ');
  }

  function isActionable(
    el: PageElement,
    role: string,
    style: PageStyle,
    parentStyle: PageStyle | null
  ): boolean {
    const tag = el.localName;
    if (ACTIONABLE_ROLES.has(role)) return true;
    // Etiketler denetimleri üzerinden erişilir; görünür denetim kendi referansını alır.
    if (tag === 'label') return false;
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary')
      return true;
    if (tag === 'input') return inputType(el) !== 'hidden';
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
    if (isEditingHost(el)) return true;
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && Number(tabIndex) >= 0) return true;
    if (el.hasAttribute('onclick')) return true;
    return style.cursor === 'pointer' && (!parentStyle || parentStyle.cursor !== 'pointer');
  }

  // ---------------------------------------------------------------------------------------
  // Anlık görüntü (snapshot)
  // ---------------------------------------------------------------------------------------

  function snapshot(input: PageCommandMap['snapshot']['input']): PageOutput<'snapshot'> {
    if (input.resetRefs) state.elementRefs = new WeakMap();
    state.refs = new Map();
    if (state.nextRef < input.refStart) state.nextRef = input.refStart;

    const budget = Math.max(400, Math.floor(input.maxChars));
    const marker = '[... snapshot truncated; scroll or use getText for the rest ...]';
    const lines: string[] = [];
    let used = 0;
    let full = false;
    let pending: string[] = [];
    let pendingDepth = 0;
    const skip = new Set<PageElement>();

    function pushLine(line: string): void {
      if (full) return;
      if (used + line.length + 1 > budget - marker.length - 1) {
        full = true;
        return;
      }
      lines.push(line);
      used += line.length + 1;
    }

    function emit(depth: number, text: string): void {
      pushLine(`${'  '.repeat(depth)}- ${text}`);
    }

    function addText(text: string, depth: number): void {
      if (full) return;
      if (pending.length === 0) pendingDepth = depth;
      pending.push(text);
    }

    function flush(): void {
      if (pending.length === 0) return;
      const text = normalize(pending.join(''));
      pending = [];
      if (text) emit(pendingDepth, `text: ${truncate(text, TEXT_MAX)}`);
    }

    function composedChildren(node: PageNode): PageNode[] {
      if (isElement(node)) {
        if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
        if (node.localName === 'slot' && node.assignedNodes) {
          const assigned = node.assignedNodes({ flatten: true });
          if (assigned.length > 0) return assigned;
        }
      }
      return Array.from(node.childNodes);
    }

    function walkChildren(
      node: PageNode,
      depth: number,
      visible: boolean,
      style: PageStyle | null
    ): void {
      for (const child of composedChildren(node)) {
        if (full) return;
        walkNode(child, depth, visible, style);
      }
    }

    /** Kapsayıcı satırı yazar, çocukları gezer; hiç çocuk satırı çıkmazsa satırı geri alır. */
    function container(
      el: PageElement,
      depth: number,
      line: string,
      visible: boolean,
      style: PageStyle
    ): void {
      flush();
      const mark = lines.length;
      const usedMark = used;
      emit(depth, `${line}:`);
      walkChildren(el, depth + 1, visible, style);
      flush();
      if (!full && lines.length === mark + 1) {
        lines.length = mark;
        used = usedMark;
      }
    }

    function walkFrame(el: PageElement, depth: number): void {
      if (!hasArea(el)) return;
      const name = nameOf(el, 'iframe');
      const head = `iframe${name ? ` ${quote(name)}` : ''}`;
      const inner = frameDocument(el);
      if (inner && inner.body) {
        container(inner.body, depth, head, true, styleOf(inner.body));
        return;
      }
      const src = el.getAttribute('src') ?? '';
      flush();
      emit(
        depth,
        `${head}${src ? ` src=${quote(displayUrl(src))}` : ''} (cross-origin, content not inspected)`
      );
    }

    function walkRow(el: PageElement, depth: number, visible: boolean, style: PageStyle): void {
      if (el.querySelector(ACTIONABLE_SELECTOR)) {
        walkChildren(el, depth, visible, style);
        return;
      }
      const cells = Array.from(el.childNodes)
        .filter(isElement)
        .filter(
          (cell) =>
            cell.localName === 'td' || cell.localName === 'th' || roleOf(cell).endsWith('cell')
        )
        .map((cell) => truncate(normalize(cell.innerText ?? cell.textContent ?? ''), 80));
      if (cells.length === 0 || cells.every((cell) => cell === '')) {
        walkChildren(el, depth, visible, style);
        return;
      }
      flush();
      emit(depth, `row: ${cells.join(' | ')}`);
    }

    function walkNode(
      node: PageNode,
      depth: number,
      visible: boolean,
      parentStyle: PageStyle | null
    ): void {
      if (node.nodeType === 3) {
        if (visible && node.nodeValue) addText(node.nodeValue, depth);
        return;
      }
      if (!isElement(node)) return;
      const el = node;
      const tag = el.localName;
      if (SKIP_TAGS.has(tag) || skip.has(el)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (tag === 'input' && inputType(el) === 'hidden') return;
      const style = styleOf(el);
      if (style.display === 'none') return;
      if (style.display !== 'contents' && el.checkVisibility && !el.checkVisibility()) return;
      if (style.display !== 'contents' && isClippedToNothing(el, style)) return;
      const selfVisible = style.visibility === 'visible';
      const inline = isInlineDisplay(style.display);
      if (!inline) flush();
      walkElement(el, tag, depth, selfVisible, style, parentStyle);
      if (!inline) flush();
    }

    function walkElement(
      el: PageElement,
      tag: string,
      depth: number,
      visible: boolean,
      style: PageStyle,
      parentStyle: PageStyle | null
    ): void {
      if (tag === 'br') {
        addText(' ', depth);
        return;
      }
      if (tag === 'iframe' || tag === 'frame') {
        if (visible) walkFrame(el, depth);
        return;
      }
      const role = roleOf(el);
      // Görsel olarak gizli form denetimini etiketi temsil eder (özel onay kutusu deseni).
      if ((tag === 'input' || tag === 'select' || tag === 'textarea') && isVisuallyHidden(el)) {
        const proxy = el.labels
          ? Array.from(el.labels).find((label) => !isVisuallyHidden(label))
          : undefined;
        if (proxy) return;
      }
      if (tag === 'label') {
        const control = el.control ?? null;
        if (control && visible && hasArea(el) && isVisuallyHidden(control)) {
          flush();
          const line = actionableLine(el, roleOf(control) || 'clickable', control);
          const hasOther = Array.from(el.querySelectorAll(ACTIONABLE_SELECTOR)).some(
            (candidate) => candidate !== control
          );
          if (hasOther) {
            container(el, depth, line, visible, style);
          } else {
            emit(depth, line);
          }
          return;
        }
      }
      if (role === 'row') {
        walkRow(el, depth, visible, style);
        return;
      }
      if (visible && isActionable(el, role, style, parentStyle) && hasArea(el)) {
        flush();
        if (
          LEAF_ROLES.has(role) ||
          tag === 'input' ||
          tag === 'select' ||
          tag === 'textarea' ||
          isEditingHost(el)
        ) {
          emit(depth, actionableLine(el, role, el));
          return;
        }
        if (tag === 'summary') {
          emit(depth, actionableLine(el, 'summary', el));
          return;
        }
        const label =
          role ||
          (style.cursor === 'pointer' || el.hasAttribute('onclick') ? 'clickable' : 'focusable');
        const text = normalize(el.innerText ?? '');
        if (!el.querySelector(ACTIONABLE_SELECTOR) && text.length <= 80) {
          emit(depth, actionableLine(el, label, el));
          return;
        }
        const ref = refFor(el);
        const name = normalize(el.getAttribute('aria-label') ?? '');
        container(
          el,
          depth,
          `${label}${name ? ` ${quote(truncate(name, NAME_MAX))}` : ''} [ref=${ref}]`,
          visible,
          style
        );
        return;
      }
      if (tag === 'svg') {
        const name = nameOf(el, role);
        if (
          visible &&
          name &&
          (role === 'img' || el.hasAttribute('aria-label') || el.querySelector('title'))
        ) {
          flush();
          emit(depth, `img ${quote(name)}`);
        }
        return;
      }
      if (tag === 'img') {
        const name = nameOf(el, role);
        if (visible && role === 'img' && name && hasArea(el)) {
          flush();
          emit(depth, `img ${quote(name)}`);
        }
        return;
      }
      if (tag === 'canvas') {
        const rect = el.getBoundingClientRect();
        if (visible && rect.width >= 2 && rect.height >= 2) {
          flush();
          const name = nameOf(el, role);
          emit(
            depth,
            `canvas${name ? ` ${quote(name)}` : ''} ${Math.round(rect.width)}x${Math.round(rect.height)}`
          );
        }
        return;
      }
      if (role === 'heading') {
        const name = nameOf(el, role);
        const level = /^h([1-6])$/.exec(tag)?.[1] ?? el.getAttribute('aria-level');
        const line = `heading${name ? ` ${quote(name)}` : ''}${level ? ` [level=${level}]` : ''}`;
        if (!visible || !name) {
          walkChildren(el, depth, visible, style);
          return;
        }
        flush();
        if (el.querySelector(ACTIONABLE_SELECTOR)) {
          container(el, depth, line, visible, style);
        } else {
          emit(depth, line);
        }
        return;
      }
      if (CONTAINER_ROLES.has(role) && visible) {
        const name = nameOf(el, role);
        container(el, depth, `${role}${name ? ` ${quote(name)}` : ''}`, visible, style);
        return;
      }
      walkChildren(el, depth, visible, style);
    }

    function isModal(el: PageElement): boolean {
      if (el.getAttribute('aria-modal') === 'true') return true;
      if (roleOf(el) === 'alertdialog') return true;
      if (el.localName !== 'dialog') return false;
      try {
        return el.matches(':modal');
      } catch {
        return false;
      }
    }

    const root = doc.body ?? doc.documentElement;
    const viewportWidth = win.innerWidth;
    const viewportHeight = win.innerHeight;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    const pageWidth = Math.max(scroller?.scrollWidth ?? 0, viewportWidth);
    const pageHeight = Math.max(scroller?.scrollHeight ?? 0, viewportHeight);
    const scrollX = Math.round(win.scrollX);
    const scrollY = Math.round(win.scrollY);
    pushLine(`URL: ${win.location.href}`);
    pushLine(`Title: ${normalize(doc.title)}`);
    pushLine(
      `Viewport: ${viewportWidth}x${viewportHeight} CSS px; scroll x=${scrollX} y=${scrollY} of max ` +
        `x=${Math.max(0, pageWidth - viewportWidth)} y=${Math.max(0, pageHeight - viewportHeight)}; ` +
        `page ${pageWidth}x${pageHeight}`
    );

    const modals = Array.from(
      doc.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
      )
    ).filter((el) => isModal(el) && styleOf(el).display !== 'none' && hasArea(el));
    const topModals = modals.filter(
      (el) => !modals.some((other) => other !== el && other.contains(el))
    );
    if (topModals.length > 0) {
      pushLine(
        'Note: a modal dialog is open; interact with it first (the page behind it is inert).'
      );
    }
    pushLine('');
    const headerLines = lines.length;
    for (const modal of topModals) {
      const name = nameOf(modal, 'dialog');
      container(modal, 0, `dialog${name ? ` ${quote(name)}` : ''} [modal]`, true, styleOf(modal));
      skip.add(modal);
    }
    if (root) {
      const rootStyle = styleOf(root);
      walkChildren(root, 0, rootStyle.visibility === 'visible', rootStyle);
    }
    flush();
    if (lines.length === headerLines) pushLine('(no visible content)');
    if (full) lines.push(marker);
    return {
      url: win.location.href,
      title: doc.title,
      outline: lines.join('\n'),
      truncated: full,
      nextRef: state.nextRef,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Hedef çözümleme ve tıklama noktası
  // ---------------------------------------------------------------------------------------

  type Resolved = { el: PageElement; label: string; point: PagePoint | null };

  function resolveTarget(
    target: PageTarget,
    followLabel: 'never' | 'visible' | 'always'
  ): Resolved {
    if ('ref' in target) {
      const ref = String(target.ref).trim();
      if (!/^e\d+$/.test(ref)) {
        throw new AgentError(
          `Invalid element ref "${ref}"; use a ref like e12 from the latest snapshot.`
        );
      }
      const el = state.refs.get(ref);
      if (!el || !el.isConnected || !el.ownerDocument || !el.ownerDocument.defaultView) {
        throw new AgentError(`Element ref ${ref} not found; take a new snapshot.`);
      }
      if (el.localName === 'label' && el.control && followLabel !== 'never') {
        if (followLabel === 'always' || !isVisuallyHidden(el.control)) {
          return { el: el.control, label: ref, point: null };
        }
      }
      return { el, label: ref, point: null };
    }
    const x = Number(target.x);
    const y = Number(target.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AgentError('Invalid coordinates; pass numbers in CSS pixels.');
    }
    if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) {
      throw new AgentError(
        `Point (${x}, ${y}) is outside the viewport (${win.innerWidth}x${win.innerHeight} CSS px).`
      );
    }
    const viewport = win.visualViewport;
    let layoutX = viewport && viewport.scale !== 1 ? x / viewport.scale + viewport.offsetLeft : x;
    let layoutY = viewport && viewport.scale !== 1 ? y / viewport.scale + viewport.offsetTop : y;
    let currentDoc: PageDocument = doc;
    let hit = deepElementFromPoint(currentDoc, layoutX, layoutY);
    for (
      let depth = 0;
      hit && (hit.localName === 'iframe' || hit.localName === 'frame') && depth < 8;
      depth++
    ) {
      const inner = frameDocument(hit);
      if (!inner) break;
      const rect = hit.getBoundingClientRect();
      const frameStyle = styleOf(hit);
      layoutX -= rect.left + hit.clientLeft + (parseFloat(frameStyle.paddingLeft) || 0);
      layoutY -= rect.top + hit.clientTop + (parseFloat(frameStyle.paddingTop) || 0);
      currentDoc = inner;
      const innerHit = deepElementFromPoint(currentDoc, layoutX, layoutY);
      if (!innerHit) break;
      hit = innerHit;
    }
    if (!hit) throw new AgentError(`No element at point (${x}, ${y}).`);
    return { el: hit, label: `the element at (${x}, ${y})`, point: { x, y } };
  }

  function acceptsHit(el: PageElement, hit: PageElement | null): boolean {
    if (!hit) return false;
    if (hit === el || composedContains(el, hit)) return true;
    if (el.localName === 'label' && el.control) {
      if (hit === el.control || composedContains(el.control, hit)) return true;
    }
    const label = hit.closest('label');
    return !!label && label.control === el;
  }

  /** Öğenin görünür kısmının merkezini (görsel görünür alan CSS pikseli) bulur. */
  function clickablePoint(el: PageElement, label: string): PagePoint {
    const view = viewOf(el);
    const rects = rectsOf(el);
    if (rects.length === 0) {
      throw new AgentError(`${label} is not visible (it has no size or is hidden).`);
    }
    let chosen: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const rect of rects) {
      const left = Math.max(rect.left, 0);
      const top = Math.max(rect.top, 0);
      const right = Math.min(rect.right, view.innerWidth);
      const bottom = Math.min(rect.bottom, view.innerHeight);
      if (right - left >= 1 && bottom - top >= 1) {
        chosen = { left, top, right, bottom };
        break;
      }
    }
    if (!chosen) {
      throw new AgentError(
        `${label} is outside the visible viewport and could not be scrolled into view.`
      );
    }
    let x = (chosen.left + chosen.right) / 2;
    let y = (chosen.top + chosen.bottom) / 2;
    const ownerDoc = el.ownerDocument ?? doc;
    const hit = deepElementFromPoint(ownerDoc, x, y);
    if (!acceptsHit(el, hit)) {
      const covering = hit ? describeElement(hit) : 'nothing';
      throw new AgentError(
        `${label} is covered by ${covering} at (${Math.round(x)}, ${Math.round(y)}); a click there ` +
          'would hit that element instead. Close or dismiss the overlay, or scroll, then retry.'
      );
    }
    let frameDoc: PageDocument = ownerDoc;
    for (let depth = 0; frameDoc !== doc && depth < 8; depth++) {
      const frameEl = frameDoc.defaultView?.frameElement ?? null;
      if (!frameEl) break;
      const rect = frameEl.getBoundingClientRect();
      const frameStyle = styleOf(frameEl);
      x += rect.left + frameEl.clientLeft + (parseFloat(frameStyle.paddingLeft) || 0);
      y += rect.top + frameEl.clientTop + (parseFloat(frameStyle.paddingTop) || 0);
      frameDoc = frameEl.ownerDocument ?? doc;
      const outerHit = deepElementFromPoint(frameDoc, x, y);
      if (outerHit !== frameEl) {
        const covering = outerHit ? describeElement(outerHit) : 'nothing';
        throw new AgentError(`${label} is inside a frame that is covered by ${covering}.`);
      }
    }
    return toVisualPoint(x, y);
  }

  function guardClick(el: PageElement, label: string): void {
    if (isDropdownSelect(el)) {
      throw new AgentError(
        `${label} is a dropdown <select>; use selectOption instead of clicking it.`
      );
    }
    if (el.localName === 'input' && inputType(el) === 'file') {
      throw new AgentError(`${label} is a file input; file uploads are not supported.`);
    }
    if (el.disabled === true) throw new AgentError(`${label} is disabled.`);
  }

  function locate(input: PageCommandMap['locate']['input']): PageOutput<'locate'> {
    const resolved = resolveTarget(input.target, input.purpose === 'click' ? 'visible' : 'never');
    if (input.purpose === 'click') guardClick(resolved.el, resolved.label);
    if (resolved.point) return { point: resolved.point, label: resolved.label };
    if (input.scroll) {
      resolved.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    return { point: clickablePoint(resolved.el, resolved.label), label: resolved.label };
  }

  // ---------------------------------------------------------------------------------------
  // Yazma
  // ---------------------------------------------------------------------------------------

  function editableMode(el: PageElement, label: string): 'text' | 'value' {
    const tag = el.localName;
    if (tag === 'input') {
      const type = inputType(el);
      if (VALUE_INPUT_TYPES.has(type)) return 'value';
      if (type === 'checkbox' || type === 'radio' || BUTTON_INPUT_TYPES.has(type)) {
        throw new AgentError(`${label} is a ${type} input; use click instead of typing into it.`);
      }
      if (type === 'file')
        throw new AgentError(`${label} is a file input; file uploads are not supported.`);
    }
    if (tag === 'select') {
      throw new AgentError(`${label} is a <select>; use selectOption instead of typing into it.`);
    }
    return 'text';
  }

  function prepareType(input: PageCommandMap['prepareType']['input']): PageOutput<'prepareType'> {
    const { el, label } = resolveTarget(input.target, 'always');
    const mode = editableMode(el, label);
    if (el.disabled === true) throw new AgentError(`${label} is disabled.`);
    if (el.readOnly === true && (el.localName === 'input' || el.localName === 'textarea')) {
      throw new AgentError(`${label} is read-only.`);
    }
    const focused = isFocusWithin(el);
    let point: PagePoint | null = null;
    let occlusion: string | null = null;
    if (!focused && mode === 'text') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      try {
        point = clickablePoint(el, label);
      } catch (error) {
        occlusion = error instanceof Error ? error.message : String(error);
      }
    }
    return { focused, point, occlusion, mode, label };
  }

  function focusTarget(input: PageCommandMap['focus']['input']): PageOutput<'focus'> {
    const { el } = resolveTarget(input.target, 'always');
    if (!isFocusWithin(el)) el.focus({ preventScroll: true });
    return { focused: isFocusWithin(el) };
  }

  function editState(): EditState {
    const active = deepActiveElement(doc);
    if (!active || active === doc.body || active === doc.documentElement) {
      return { kind: 'none', label: 'nothing', empty: true, allSelected: false };
    }
    const label = describeElement(active);
    const tag = active.localName;
    if ((tag === 'input' && TEXT_INPUT_TYPES.has(inputType(active))) || tag === 'textarea') {
      const value = active.value ?? '';
      const start = active.selectionStart;
      const end = active.selectionEnd;
      return {
        kind: tag === 'input' ? 'input' : 'textarea',
        label,
        empty: value.length === 0,
        allSelected: value.length > 0 && start === 0 && end === value.length,
      };
    }
    if (active.isContentEditable) {
      const text = normalize(active.innerText ?? '');
      const selection = viewOf(active).getSelection();
      const selected = normalize(selection ? selection.toString() : '');
      return {
        kind: 'contenteditable',
        label,
        empty: text.length === 0,
        allSelected: text.length > 0 && selected.length >= text.length,
      };
    }
    return { kind: 'other', label, empty: false, allSelected: false };
  }

  function caretToEnd(): PageOutput<'caretToEnd'> {
    const active = deepActiveElement(doc);
    if (!active) return { moved: false };
    if (active.localName === 'input' || active.localName === 'textarea') {
      const length = (active.value ?? '').length;
      try {
        active.setSelectionRange?.(length, length);
        return { moved: true };
      } catch {
        return { moved: false };
      }
    }
    if (active.isContentEditable && active.ownerDocument) {
      const selection = viewOf(active).getSelection();
      if (!selection) return { moved: false };
      const range = active.ownerDocument.createRange();
      range.selectNodeContents(active);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return { moved: true };
    }
    return { moved: false };
  }

  function setNativeValue(el: PageElement, value: string): void {
    const view = viewOf(el);
    const proto =
      el.localName === 'textarea'
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function forceClear(): PageOutput<'forceClear'> {
    const active = deepActiveElement(doc);
    if (!active) return { empty: false };
    const view = viewOf(active);
    if (active.localName === 'input' || active.localName === 'textarea') {
      setNativeValue(active, '');
      active.dispatchEvent(new view.Event('input', { bubbles: true }));
      return { empty: (active.value ?? '') === '' };
    }
    if (active.isContentEditable && active.ownerDocument) {
      view.getSelection()?.selectAllChildren(active);
      active.ownerDocument.execCommand('delete');
      if (normalize(active.innerText ?? '') !== '') {
        active.textContent = '';
        active.dispatchEvent(new view.Event('input', { bubbles: true }));
      }
      return { empty: normalize(active.innerText ?? '') === '' };
    }
    return { empty: false };
  }

  function setValue(input: PageCommandMap['setValue']['input']): PageOutput<'setValue'> {
    const { el, label } = resolveTarget(input.target, 'always');
    if (el.localName !== 'input' || !VALUE_INPUT_TYPES.has(inputType(el))) {
      throw new AgentError(`${label} does not accept a direct value.`);
    }
    if (el.disabled === true) throw new AgentError(`${label} is disabled.`);
    const view = viewOf(el);
    setNativeValue(el, input.value);
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
    const current = el.value ?? '';
    if (current.toLowerCase() !== input.value.toLowerCase()) {
      const formats: Record<string, string> = {
        date: 'YYYY-MM-DD',
        time: 'HH:MM',
        'datetime-local': 'YYYY-MM-DDTHH:MM',
        month: 'YYYY-MM',
        week: 'YYYY-Www',
        color: '#rrggbb',
        range: 'a number within the allowed range',
      };
      const type = inputType(el);
      throw new AgentError(
        `${label} rejected the value ${quote(input.value)} (current value ${quote(current)}); ` +
          `expected format for type=${type}: ${formats[type] ?? 'a valid value'}.`
      );
    }
    return { value: current };
  }

  // ---------------------------------------------------------------------------------------
  // Kaydırma
  // ---------------------------------------------------------------------------------------

  function canScroll(el: PageElement, direction: ScrollDirection): boolean {
    const vertical = direction === 'up' || direction === 'down';
    const style = styleOf(el);
    const overflow = vertical ? style.overflowY : style.overflowX;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    if (vertical) {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      return direction === 'down'
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollTop > 0;
    }
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    return direction === 'right'
      ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      : el.scrollLeft > 0;
  }

  function scrollContainerFor(
    anchor: PageElement | null,
    direction: ScrollDirection
  ): PageElement | null {
    for (let current = anchor; current; current = composedParentElement(current)) {
      if (current === doc.body || current === doc.documentElement) break;
      if (canScroll(current, direction)) return current;
    }
    return doc.scrollingElement ?? doc.documentElement;
  }

  function scrollProbe(input: PageCommandMap['scrollProbe']['input']): PageOutput<'scrollProbe'> {
    let anchor: PageElement | null = null;
    let point: PagePoint;
    if (input.target) {
      const resolved = resolveTarget(input.target, 'never');
      anchor = resolved.el;
      if (resolved.point) {
        point = resolved.point;
      } else {
        resolved.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        const rect = resolved.el.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.right, win.innerWidth);
        const bottom = Math.min(rect.bottom, win.innerHeight);
        point =
          right > left && bottom > top
            ? toVisualPoint((left + right) / 2, (top + bottom) / 2)
            : toVisualPoint(win.innerWidth / 2, win.innerHeight / 2);
      }
    } else {
      point = toVisualPoint(win.innerWidth / 2, win.innerHeight / 2);
      anchor = deepElementFromPoint(doc, win.innerWidth / 2, win.innerHeight / 2);
    }
    const scrollContainer = scrollContainerFor(anchor, input.direction);
    state.scrollContainer = scrollContainer;
    const vertical = input.direction === 'up' || input.direction === 'down';
    const viewportSize = vertical ? win.innerHeight : win.innerWidth;
    const isDocumentScroller = !scrollContainer || scrollContainer === doc.scrollingElement;
    const containerSize = isDocumentScroller
      ? viewportSize
      : vertical
        ? scrollContainer.clientHeight
        : scrollContainer.clientWidth;
    const defaultAmount = Math.max(
      1,
      Math.round(Math.min(viewportSize, containerSize || viewportSize) * 0.8)
    );
    return { point, position: readScroll(scrollContainer), defaultAmount };
  }

  function currentScrollContainer(): PageElement | null {
    const container = state.scrollContainer;
    return container && container.isConnected
      ? container
      : (doc.scrollingElement ?? doc.documentElement);
  }

  function scrollByAmount(input: PageCommandMap['scrollBy']['input']): PageOutput<'scrollBy'> {
    const container = currentScrollContainer();
    const amount = Math.abs(input.amount);
    const top = input.direction === 'down' ? amount : input.direction === 'up' ? -amount : 0;
    const left = input.direction === 'right' ? amount : input.direction === 'left' ? -amount : 0;
    if (container) container.scrollBy({ top, left, behavior: 'instant' });
    return { position: readScroll(container) };
  }

  // ---------------------------------------------------------------------------------------
  // Seçim kutusu, metin ve ölçüler
  // ---------------------------------------------------------------------------------------

  function selectOption(
    input: PageCommandMap['selectOption']['input']
  ): PageOutput<'selectOption'> {
    const { el, label } = resolveTarget(input.target, 'always');
    if (el.localName !== 'select') {
      const role = roleOf(el);
      const hint =
        role === 'combobox' || role === 'listbox' || role === 'button'
          ? ' It looks like a custom dropdown: click it to open the list, then click the option.'
          : '';
      throw new AgentError(`${label} is not a <select> element.${hint}`);
    }
    if (el.disabled === true) throw new AgentError(`${label} is disabled.`);
    const options = el.options ? Array.from(el.options) : [];
    const values = input.values.map((value) => String(value));
    if (values.length === 0) throw new AgentError('Pass at least one option value or label.');
    if (!el.multiple && values.length > 1) {
      throw new AgentError(`${label} allows a single selection; pass exactly one value.`);
    }
    const matched: PageOption[] = [];
    for (const value of values) {
      const wanted = normalize(value);
      const option =
        options.find((candidate) => candidate.value === value) ??
        options.find((candidate) => optionLabel(candidate) === wanted) ??
        options.find(
          (candidate) => optionLabel(candidate).toLowerCase() === wanted.toLowerCase()
        ) ??
        options.find((candidate) => candidate.value.toLowerCase() === wanted.toLowerCase());
      if (!option) {
        const available = options
          .slice(0, 30)
          .map((candidate) => {
            const text = optionLabel(candidate);
            return candidate.value && candidate.value !== text
              ? `${quote(text)} (value ${quote(candidate.value)})`
              : quote(text);
          })
          .join(', ');
        const more = options.length > 30 ? `, … (+${options.length - 30} more)` : '';
        throw new AgentError(
          `No option matching ${quote(value)} in ${label}. Available options: ${available || '(none)'}${more}.`
        );
      }
      if (option.disabled)
        throw new AgentError(`Option ${quote(optionLabel(option))} in ${label} is disabled.`);
      matched.push(option);
    }
    if (el.multiple) {
      for (const option of options) option.selected = matched.includes(option);
    } else if (matched[0]) {
      matched[0].selected = true;
    }
    const view = viewOf(el);
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
    const selected = el.selectedOptions
      ? Array.from(el.selectedOptions)
      : options.filter((o) => o.selected);
    return { selected: selected.map((option) => option.value) };
  }

  function normalizeText(raw: string): string {
    return raw
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pageText(input: PageCommandMap['text']['input']): PageOutput<'text'> {
    const root = doc.body ?? doc.documentElement;
    const text = normalizeText(root ? (root.innerText ?? root.textContent ?? '') : '');
    const max = Math.max(1, Math.floor(input.maxChars));
    return text.length > max
      ? { text: text.slice(0, max), truncated: true }
      : { text, truncated: false };
  }

  /** Açık gölge köklerini ve aynı kaynaklı çerçeveleri de içeren sayfa metni. */
  function collectText(root: PageDocument, depth: number): string {
    const body = root.body ?? root.documentElement;
    const parts: string[] = [body ? (body.innerText ?? body.textContent ?? '') : ''];
    const visit = (
      scope: { querySelectorAll(selector: string): ArrayLike<PageElement> },
      level: number
    ) => {
      if (level > 8) return;
      for (const el of Array.from(scope.querySelectorAll('*'))) {
        const shadow = el.shadowRoot;
        if (shadow) {
          for (const child of Array.from(shadow.childNodes)) {
            if (isElement(child)) parts.push(child.innerText ?? child.textContent ?? '');
            else if (child.nodeType === 3) parts.push(child.nodeValue ?? '');
          }
          visit(shadow, level + 1);
        }
        if ((el.localName === 'iframe' || el.localName === 'frame') && depth < 3) {
          const inner = frameDocument(el);
          if (inner) parts.push(collectText(inner, depth + 1));
        }
      }
    };
    visit(root, 0);
    return parts.join('\n');
  }

  function matchText(input: PageCommandMap['matchText']['input']): PageOutput<'matchText'> {
    const haystack = normalize(collectText(doc, 0)).toLowerCase();
    const has = (needle: string) => haystack.includes(normalize(needle).toLowerCase());
    return {
      textFound: input.text === null ? true : has(input.text),
      textGoneAbsent: input.textGone === null ? true : !has(input.textGone),
    };
  }

  function metrics(): PageMetrics {
    const scroller = doc.scrollingElement ?? doc.documentElement;
    return {
      viewportWidth: win.innerWidth,
      viewportHeight: win.innerHeight,
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      contentWidth: Math.max(scroller?.scrollWidth ?? 0, win.innerWidth),
      contentHeight: Math.max(scroller?.scrollHeight ?? 0, win.innerHeight),
      devicePixelRatio: win.devicePixelRatio || 1,
    };
  }

  function watchKey(): PageOutput<'watchKey'> {
    if (state.keyWatch) win.removeEventListener('keydown', state.keyWatch.listener, true);
    const watch: KeyWatch = {
      event: null,
      listener: (event) => {
        if (!watch.event) watch.event = event;
      },
    };
    win.addEventListener('keydown', watch.listener, true);
    state.keyWatch = watch;
    return { watching: true };
  }

  function keyResult(): PageOutput<'keyResult'> {
    const watch = state.keyWatch;
    if (!watch) return { seen: false, defaultPrevented: false };
    win.removeEventListener('keydown', watch.listener, true);
    state.keyWatch = null;
    return { seen: watch.event !== null, defaultPrevented: watch.event?.defaultPrevented === true };
  }

  try {
    switch (command.kind) {
      case 'snapshot':
        return { ok: true, value: snapshot(command) };
      case 'locate':
        return { ok: true, value: locate(command) };
      case 'prepareType':
        return { ok: true, value: prepareType(command) };
      case 'focus':
        return { ok: true, value: focusTarget(command) };
      case 'editState':
        return { ok: true, value: editState() };
      case 'caretToEnd':
        return { ok: true, value: caretToEnd() };
      case 'forceClear':
        return { ok: true, value: forceClear() };
      case 'setValue':
        return { ok: true, value: setValue(command) };
      case 'scrollProbe':
        return { ok: true, value: scrollProbe(command) };
      case 'scrollRead':
        return { ok: true, value: { position: readScroll(currentScrollContainer()) } };
      case 'scrollBy':
        return { ok: true, value: scrollByAmount(command) };
      case 'selectOption':
        return { ok: true, value: selectOption(command) };
      case 'text':
        return { ok: true, value: pageText(command) };
      case 'matchText':
        return { ok: true, value: matchText(command) };
      case 'metrics':
        return { ok: true, value: metrics() };
      case 'watchKey':
        return { ok: true, value: watchKey() };
      case 'keyResult':
        return { ok: true, value: keyResult() };
      default:
        return { ok: false, error: 'Unknown page command.' };
    }
  } catch (error) {
    if (error instanceof AgentError) return { ok: false, error: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Page script failed: ${message}` };
  }
}

/** Komutu izole dünyada çalıştırılacak kaynağa çevirir. */
export function buildPageScript(command: PageCommand): string {
  return `(${pageAgent.toString()})(window, ${JSON.stringify(PAGE_AGENT_VERSION)}, ${JSON.stringify(command)})`;
}
