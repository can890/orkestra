import type { BrowserKeyModifier } from '@core/primitives/browser/api/agent-browser';

/**
 * Ajanın tuş ifadelerini ("Control+Shift+K", "Meta+L", "Enter", "ArrowDown", "a", "Space")
 * Electron `sendInputEvent` klavye olaylarına çevirir.
 *
 * Electron 40'ta `keyDown` olayı `rawKeyDown`'a dönüştürülür ve metin eklemez; yazdırılabilir
 * karakterler ayrıca `char` olayıyla gönderilmelidir. Enter için `char` olayı "\r" taşır
 * (form gönderimi ve textarea satır sonu bu olayla tetiklenir). keyCode değerleri Electron
 * hızlandırıcı adlarıdır ("Up", "PageDown", "Escape" ...); DOM adları ("ArrowUp") geçersizdir.
 */

export type ParsedKey = {
  /** keyDown/keyUp için Electron tuş adı; yalnızca değiştirici basışında null. */
  keyCode: string | null;
  /** `char` olayıyla gönderilecek metin (yazdırılabilir tuşlar ve Enter). */
  text: string | null;
  modifiers: BrowserKeyModifier[];
};

type NamedKey = { keyCode: string; text: string | null };

const MODIFIER_ALIASES: Record<string, BrowserKeyModifier | 'primary'> = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
  os: 'meta',
  controlormeta: 'primary',
  ctrlormeta: 'primary',
  cmdorctrl: 'primary',
  commandorcontrol: 'primary',
  mod: 'primary',
};

const MODIFIER_KEY_CODES: Record<BrowserKeyModifier, string> = {
  shift: 'Shift',
  control: 'Control',
  alt: 'Alt',
  meta: 'Meta',
};

const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { keyCode: 'Enter', text: '\r' },
  return: { keyCode: 'Enter', text: '\r' },
  tab: { keyCode: 'Tab', text: null },
  escape: { keyCode: 'Escape', text: null },
  esc: { keyCode: 'Escape', text: null },
  backspace: { keyCode: 'Backspace', text: null },
  delete: { keyCode: 'Delete', text: null },
  del: { keyCode: 'Delete', text: null },
  insert: { keyCode: 'Insert', text: null },
  space: { keyCode: 'Space', text: ' ' },
  spacebar: { keyCode: 'Space', text: ' ' },
  arrowup: { keyCode: 'Up', text: null },
  up: { keyCode: 'Up', text: null },
  arrowdown: { keyCode: 'Down', text: null },
  down: { keyCode: 'Down', text: null },
  arrowleft: { keyCode: 'Left', text: null },
  left: { keyCode: 'Left', text: null },
  arrowright: { keyCode: 'Right', text: null },
  right: { keyCode: 'Right', text: null },
  home: { keyCode: 'Home', text: null },
  end: { keyCode: 'End', text: null },
  pageup: { keyCode: 'PageUp', text: null },
  pagedown: { keyCode: 'PageDown', text: null },
  plus: { keyCode: 'Plus', text: '+' },
  minus: { keyCode: '-', text: '-' },
  capslock: { keyCode: 'Capslock', text: null },
  numlock: { keyCode: 'Numlock', text: null },
  scrolllock: { keyCode: 'Scrolllock', text: null },
  printscreen: { keyCode: 'PrintScreen', text: null },
};

const KEY_HELP =
  'Use a key name such as Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ' +
  'ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1-F24, or a single ' +
  'character, optionally with modifiers (Shift, Control, Alt, Meta), e.g. "Control+A".';

function splitTokens(input: string): string[] {
  if (input === '+') return ['+'];
  const parts = input.endsWith('++') ? [...input.slice(0, -2).split('+'), '+'] : input.split('+');
  return parts.map((part) => (part === ' ' ? part : part.trim())).filter((part) => part.length > 0);
}

function resolveModifier(token: string, platform: NodeJS.Platform): BrowserKeyModifier | null {
  const alias = MODIFIER_ALIASES[token.toLowerCase()];
  if (!alias) return null;
  if (alias === 'primary') return platform === 'darwin' ? 'meta' : 'control';
  return alias;
}

function resolveKey(token: string): (NamedKey & { implicitShift: boolean }) | null {
  if (token === ' ') return { keyCode: 'Space', text: ' ', implicitShift: false };
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return { ...named, implicitShift: false };
  const fn = /^f([1-9]|1\d|2[0-4])$/i.exec(token);
  if (fn) return { keyCode: `F${fn[1]}`, text: null, implicitShift: false };
  const letterCode = /^key([a-z])$/i.exec(token);
  if (letterCode?.[1]) {
    const letter = letterCode[1].toLowerCase();
    return { keyCode: letter, text: letter, implicitShift: false };
  }
  const digitCode = /^digit([0-9])$/i.exec(token);
  if (digitCode?.[1]) return { keyCode: digitCode[1], text: digitCode[1], implicitShift: false };
  const chars = Array.from(token);
  if (chars.length === 1) {
    const isUpperLetter = token !== token.toLowerCase() && token === token.toUpperCase();
    return { keyCode: token, text: token, implicitShift: isUpperLetter };
  }
  return null;
}

/** Tuş ifadesini ayrıştırır; geçersiz ifadede ajana yönelik açıklayıcı bir hata fırlatır. */
export function parseKeyCombo(input: string, platform: NodeJS.Platform): ParsedKey {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Missing key. ${KEY_HELP}`);
  }
  const tokens = splitTokens(input === ' ' ? input : input.trim());
  const keyToken = tokens[tokens.length - 1];
  if (!keyToken) throw new Error(`Invalid key "${input}". ${KEY_HELP}`);
  const modifiers: BrowserKeyModifier[] = [];
  const addModifier = (modifier: BrowserKeyModifier) => {
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  };
  for (const token of tokens.slice(0, -1)) {
    const modifier = resolveModifier(token, platform);
    if (!modifier) {
      throw new Error(`Unknown modifier "${token}" in "${input}". ${KEY_HELP}`);
    }
    addModifier(modifier);
  }
  const keyModifier = resolveModifier(keyToken, platform);
  if (keyModifier) {
    addModifier(keyModifier);
    return { keyCode: null, text: null, modifiers };
  }
  const key = resolveKey(keyToken);
  if (!key) throw new Error(`Unknown key "${keyToken}" in "${input}". ${KEY_HELP}`);
  const commandHeld = modifiers.some((modifier) => modifier !== 'shift');
  // Tek başına "A" büyük harf yazar (Shift+A); "Meta+A" ise A tuşudur, Shift eklenmez.
  if (key.implicitShift && !commandHeld) addModifier('shift');
  let { keyCode, text } = key;
  if (key.implicitShift && commandHeld) {
    keyCode = keyCode.toLowerCase();
    text = text?.toLowerCase() ?? null;
  }
  if (!commandHeld && modifiers.includes('shift') && text !== null && /^[a-z]$/.test(text)) {
    text = text.toUpperCase();
  }
  return { keyCode, text, modifiers };
}

/**
 * Gerçek bir klavyeye benzer olay dizisi: değiştiriciler basılır, tuş basılır, yazdırılabilir
 * tuşlarda `char` gönderilir (Control/Meta/Alt basılıyken gönderilmez), sonra ters sırayla
 * bırakılır.
 */
export function keyEventSequence(parsed: ParsedKey): Electron.KeyboardInputEvent[] {
  const events: Electron.KeyboardInputEvent[] = [];
  const held: BrowserKeyModifier[] = [];
  for (const modifier of parsed.modifiers) {
    held.push(modifier);
    events.push({ type: 'keyDown', keyCode: MODIFIER_KEY_CODES[modifier], modifiers: [...held] });
  }
  if (parsed.keyCode !== null) {
    events.push({ type: 'keyDown', keyCode: parsed.keyCode, modifiers: [...held] });
    const commandHeld = held.includes('control') || held.includes('meta') || held.includes('alt');
    if (parsed.text !== null && !commandHeld) {
      events.push({ type: 'char', keyCode: parsed.text, modifiers: [...held] });
    }
    events.push({ type: 'keyUp', keyCode: parsed.keyCode, modifiers: [...held] });
  }
  for (const modifier of [...parsed.modifiers].reverse()) {
    held.pop();
    events.push({ type: 'keyUp', keyCode: MODIFIER_KEY_CODES[modifier], modifiers: [...held] });
  }
  return events;
}

/** Platformun "tümünü seç" kısayolu: macOS'ta Meta+A, diğerlerinde Control+A. */
export function selectAllChord(platform: NodeJS.Platform): ParsedKey {
  return { keyCode: 'a', text: 'a', modifiers: [platform === 'darwin' ? 'meta' : 'control'] };
}

export function isSelectAllChord(parsed: ParsedKey, platform: NodeJS.Platform): boolean {
  const primary: BrowserKeyModifier = platform === 'darwin' ? 'meta' : 'control';
  return (
    parsed.keyCode?.toLowerCase() === 'a' &&
    parsed.modifiers.length === 1 &&
    parsed.modifiers[0] === primary
  );
}

/**
 * Sistem panosundan yapıştırma kısayolları. Ajan bunlarla kullanıcının panosundaki (ör. parola)
 * içeriği sayfaya aktarıp okuyabilirdi; bu yüzden reddedilir.
 */
export function isClipboardPasteChord(parsed: ParsedKey): boolean {
  const key = parsed.keyCode?.toLowerCase();
  if (key === 'v' && (parsed.modifiers.includes('control') || parsed.modifiers.includes('meta'))) {
    return true;
  }
  return key === 'insert' && parsed.modifiers.includes('shift');
}
