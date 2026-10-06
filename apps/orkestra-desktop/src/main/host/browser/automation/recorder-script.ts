import type { PageElement, PageWindow } from './page-dom';
import {
  PAGE_AGENT_VERSION,
  pageAgent,
  type PageCommand,
  type PageElementDescription,
  type PageResult,
} from './page-script';

/**
 * Kullanıcının sayfadaki eylemlerini kaydeden betik. Ajan betiğiyle aynı izole dünyada
 * (PAGE_AGENT_WORLD_ID) çalışır; sayfanın kendi betikleri ona erişemez. Öğe tanımları için
 * `pageAgent`'ın `describe` komutunu doğrudan öğe vererek çağırır.
 *
 * Adımlar `console.debug(önek + nonce + ':' + JSON)` ile ana sürece iletilir: konsol çağrısı
 * eşzamanlıdır, bu yüzden sayfadan ayrılmayı tetikleyen bir tıklama da kaybolmaz. Nonce
 * kayıt başına rastgeledir ve yalnızca izole dünyada durur; sayfa sahte adım üretemez.
 *
 * `pageRecorder` kendi kendine yeterli olmalıdır (kaynağı toString ile enjekte edilir);
 * modül kapsamındaki hiçbir değere başvuramaz.
 */

export const RECORDER_MESSAGE_PREFIX = 'orkestra-recorder:';

/** Kayıt betiğinin sayfaya gönderdiği ham adım (ana süreç doğrular). */
export type RecorderMessage = { at: number; step: Record<string, unknown> };

type RecorderEvent = {
  readonly type: string;
  readonly isTrusted: boolean;
  readonly target: unknown;
  readonly button?: number;
  readonly detail?: number;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
  composedPath?(): unknown[];
};

type RecorderWindow = PageWindow & {
  readonly console: { debug(message: string): void };
  __orkestraRecorder?: { nonce: string; stop(): string[] };
};

type Pending = { el: PageElement; description: PageElementDescription; at: number };

export function pageRecorder(
  win: RecorderWindow,
  nonce: string,
  prefix: string,
  version: string,
  agent: (win: PageWindow, version: string, command: PageCommand) => PageResult,
  mode: 'start' | 'stop'
): string[] {
  const existing = win.__orkestraRecorder;
  if (mode === 'stop') {
    if (!existing) return [];
    delete win.__orkestraRecorder;
    return existing.stop();
  }
  if (existing) {
    if (existing.nonce === nonce) return [];
    existing.stop();
  }

  const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab']);
  const NAVIGATION_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
  ]);
  let pending: Pending | null = null;

  function describe(el: PageElement): PageElementDescription | null {
    const result = agent(win, version, {
      kind: 'describe',
      target: { element: el },
    } as PageCommand);
    return result.ok ? (result.value as PageElementDescription) : null;
  }

  function locatorOf(description: PageElementDescription): Record<string, string> {
    return description.text
      ? { selector: description.selector, text: description.text }
      : { selector: description.selector };
  }

  function message(step: Record<string, unknown>, at: number): string {
    return `${prefix}${nonce}:${JSON.stringify({ at, step })}`;
  }

  function send(step: Record<string, unknown>, at: number = Date.now()): void {
    try {
      win.console.debug(message(step, at));
    } catch {
      // Kayıt, sayfanın konsolu bozulmuşsa sessizce durur.
    }
  }

  function elementOf(event: RecorderEvent): PageElement | null {
    const path = event.composedPath ? event.composedPath() : [];
    const first = (path.length > 0 ? path[0] : event.target) as PageElement | null;
    return first && typeof first === 'object' && first.nodeType === 1 ? first : null;
  }

  function editableValue(el: PageElement): string {
    if (el.localName === 'input' || el.localName === 'textarea') return String(el.value ?? '');
    return String(el.innerText ?? el.textContent ?? '');
  }

  function pendingStep(): { step: Record<string, unknown>; at: number } | null {
    const current = pending;
    pending = null;
    if (!current || !current.el.isConnected) return null;
    const step: Record<string, unknown> = {
      action: 'type',
      target: locatorOf(current.description),
      text: current.description.secret ? '' : editableValue(current.el),
      clear: true,
    };
    if (current.description.secret) step.secret = true;
    return { step, at: current.at };
  }

  function flush(): void {
    const next = pendingStep();
    if (next) send(next.step, next.at);
  }

  function modifiers(event: RecorderEvent): string[] {
    const list: string[] = [];
    if (event.shiftKey) list.push('shift');
    if (event.ctrlKey) list.push('control');
    if (event.altKey) list.push('alt');
    if (event.metaKey) list.push('meta');
    return list;
  }

  const onClick = (raw: unknown) => {
    const event = raw as RecorderEvent;
    if (!event.isTrusted) return;
    const el = elementOf(event);
    if (!el) return;
    if (pending && pending.el !== el && !pending.el.contains(el)) flush();
    const description = describe(el);
    if (!description) return;
    const step: Record<string, unknown> = { action: 'click', target: locatorOf(description) };
    if (event.button === 1) step.button = 'middle';
    const mods = modifiers(event);
    if (mods.length > 0) step.modifiers = mods;
    if ((event.detail ?? 1) === 2) step.clickCount = 2;
    send(step);
  };

  const onInput = (raw: unknown) => {
    const event = raw as RecorderEvent;
    if (!event.isTrusted) return;
    const el = elementOf(event);
    if (!el || el.localName === 'select') return;
    if (pending && pending.el === el) {
      pending.at = Date.now();
      return;
    }
    flush();
    const description = describe(el);
    if (!description || description.editable !== 'text') return;
    pending = { el, description, at: Date.now() };
  };

  const onChange = (raw: unknown) => {
    const event = raw as RecorderEvent;
    if (!event.isTrusted) return;
    const el = elementOf(event);
    if (!el) return;
    if (el.localName === 'select') {
      const description = describe(el);
      const selected = el.selectedOptions ? Array.from(el.selectedOptions) : [];
      if (!description || selected.length === 0) return;
      send({
        action: 'select',
        target: locatorOf(description),
        values: selected.map((option) => option.value),
      });
      return;
    }
    if (pending && pending.el === el) flush();
  };

  const onKeyDown = (raw: unknown) => {
    const event = raw as RecorderEvent;
    if (!event.isTrusted || event.isComposing || !event.key) return;
    const key = event.key;
    const el = elementOf(event);
    const editing = !!pending && !!el && (pending.el === el || pending.el.contains(el));
    if (!NAMED_KEYS.has(key) && (editing || !NAVIGATION_KEYS.has(key))) return;
    if (event.ctrlKey || event.metaKey) return;
    if (pending) flush();
    const parts: string[] = [];
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');
    parts.push(key);
    send({ action: 'press', key: parts.join('+') });
  };

  const onFocusOut = (raw: unknown) => {
    const event = raw as RecorderEvent;
    const el = elementOf(event);
    if (pending && el && pending.el === el) flush();
  };

  const onPageHide = () => flush();

  const doc = win.document as unknown as {
    addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
    removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
  };
  const listeners: Array<[string, (event: unknown) => void]> = [
    ['click', onClick],
    ['auxclick', onClick],
    ['input', onInput],
    ['change', onChange],
    ['keydown', onKeyDown],
    ['focusout', onFocusOut],
  ];
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);
  win.addEventListener('pagehide', onPageHide as never, true);

  win.__orkestraRecorder = {
    nonce,
    stop() {
      for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true);
      win.removeEventListener('pagehide', onPageHide as never, true);
      const next = pendingStep();
      return next ? [message(next.step, next.at)] : [];
    },
  };
  return [];
}

/** Kayıt betiğini başlatan ya da durduran kaynak (izole dünyada çalıştırılır). */
export function buildRecorderScript(nonce: string, mode: 'start' | 'stop'): string {
  return `(${pageRecorder.toString()})(window, ${JSON.stringify(nonce)}, ${JSON.stringify(RECORDER_MESSAGE_PREFIX)}, ${JSON.stringify(PAGE_AGENT_VERSION)}, ${pageAgent.toString()}, ${JSON.stringify(mode)})`;
}

/** Konsol mesajı bir kayıt mesajıysa çözümler; nonce tutmuyorsa `stale` döner. */
export function parseRecorderMessage(
  raw: string,
  nonce: string | null
): RecorderMessage | 'stale' | null {
  if (!raw.startsWith(RECORDER_MESSAGE_PREFIX)) return null;
  const rest = raw.slice(RECORDER_MESSAGE_PREFIX.length);
  if (!nonce || !rest.startsWith(`${nonce}:`)) return 'stale';
  try {
    const parsed = JSON.parse(rest.slice(nonce.length + 1)) as Partial<RecorderMessage>;
    if (typeof parsed.at !== 'number' || !parsed.step || typeof parsed.step !== 'object') {
      return 'stale';
    }
    return { at: parsed.at, step: parsed.step };
  } catch {
    return 'stale';
  }
}
