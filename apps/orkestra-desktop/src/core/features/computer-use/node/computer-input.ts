/**
 * Masaüstü girdisi için doğrulama ve sabit JXA betiği.
 *
 * Güvenlik: betik kaynağı sabittir; metin, tuş kodu ve koordinatlar betiğe yalnızca stdin'den JSON
 * olarak geçer, asla kaynağa string birleştirmeyle gömülmez. Değerler ayrıca burada doğrulanır
 * (izin listesi, sonlu sayı, ekran sınırları) ve betik içinde savunma amaçlı yeniden denetlenir.
 */

export class ComputerToolError extends Error {}

/** Tuş adı → macOS sanal tuş kodu. İzin listesi bu tablodur; dışındaki adlar reddedilir. */
const NAMED_KEYS: Readonly<Record<string, number>> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

/** ANSI düzeninde harf ve rakam tuşları; kısayollar (cmd+c gibi) için. */
const CHARACTER_KEYS: Readonly<Record<string, number>> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '9': 25,
  '7': 26,
  '8': 28,
  '0': 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
};

const KEY_CODES: Readonly<Record<string, number>> = { ...NAMED_KEYS, ...CHARACTER_KEYS };

/** Aracın kabul ettiği tuş adları (şema ve hata iletisi için). */
export const COMPUTER_KEY_NAMES: readonly string[] = Object.keys(KEY_CODES);

/** Değiştirici adı → CGEventFlags maskesi. */
const MODIFIER_FLAGS: Readonly<Record<string, number>> = {
  cmd: 0x100000,
  command: 0x100000,
  shift: 0x20000,
  option: 0x80000,
  alt: 0x80000,
  control: 0x40000,
  ctrl: 0x40000,
};

export const COMPUTER_MODIFIER_NAMES: readonly string[] = Object.keys(MODIFIER_FLAGS);

export const MAX_TYPE_TEXT_LENGTH = 2000;
/** Her osascript çağrısında yazılacak en çok kod noktası; durdurma çağrılar arasında denetlenir. */
export const TYPE_CHUNK_SIZE = 80;

export type DisplayInfo = { width: number; height: number; scale: number };

export type ParsedKey = { name: string; keyCode: number; modifiers: string[]; flags: number };

export function parseKey(name: unknown, modifiers: unknown): ParsedKey {
  if (typeof name !== 'string') throw new ComputerToolError('key must be a string.');
  const normalized = name.trim().toLowerCase();
  if (!Object.hasOwn(KEY_CODES, normalized)) {
    throw new ComputerToolError(
      `Unsupported key "${name.slice(0, 32)}". Allowed keys: ${COMPUTER_KEY_NAMES.join(', ')}.`
    );
  }
  const list = modifiers === undefined ? [] : modifiers;
  if (!Array.isArray(list) || list.length > 4) {
    throw new ComputerToolError('modifiers must be an array of at most 4 names.');
  }
  let flags = 0;
  const seen: string[] = [];
  for (const entry of list) {
    const modifier = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const mask = Object.hasOwn(MODIFIER_FLAGS, modifier) ? MODIFIER_FLAGS[modifier] : undefined;
    if (mask === undefined) {
      throw new ComputerToolError(
        `Unsupported modifier. Allowed modifiers: ${COMPUTER_MODIFIER_NAMES.join(', ')}.`
      );
    }
    flags |= mask;
    seen.push(modifier);
  }
  // Harf ve rakam tuşları yalnızca bir değiştirici ile anlamlıdır; düz yazı için type_text var.
  if (Object.hasOwn(CHARACTER_KEYS, normalized) && seen.length === 0) {
    throw new ComputerToolError(
      'Letter and digit keys need at least one modifier (for example cmd+c). Use type_text to type text.'
    );
  }
  return { name: normalized, keyCode: KEY_CODES[normalized] as number, modifiers: seen, flags };
}

export function parseCoordinate(value: unknown, axis: 'x' | 'y', display: DisplayInfo): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ComputerToolError(`${axis} must be a finite number.`);
  }
  const limit = axis === 'x' ? display.width : display.height;
  if (value < 0 || value >= limit) {
    throw new ComputerToolError(
      `${axis}=${value} is outside the screen (0 to ${limit - 1} in screenshot pixels).`
    );
  }
  return Math.round(value);
}

export function parseTypeText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ComputerToolError('text must be a non-empty string.');
  }
  if (value.length > MAX_TYPE_TEXT_LENGTH) {
    throw new ComputerToolError(`text is longer than ${MAX_TYPE_TEXT_LENGTH} characters.`);
  }
  // Satır sonu ve sekme dışındaki denetim karakterleri yazılmaz.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ComputerToolError('text contains control characters.');
  }
  return value;
}

/** Metni kod noktası sınırlarında parçalara böler (vekil çiftler asla ayrılmaz). */
export function chunkText(text: string, size: number = TYPE_CHUNK_SIZE): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += size) {
    chunks.push(points.slice(index, index + size).join(''));
  }
  return chunks;
}

/** JXA'ya stdin'den JSON olarak geçen istek; betik kaynağıyla hiçbir ilişkisi yoktur. */
export type InputRequest =
  | { action: 'info' }
  | { action: 'move'; x: number; y: number }
  | { action: 'click'; x: number; y: number; button: 'left' | 'right'; clicks: 1 | 2 }
  | { action: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keyCode: number; flags: number };

/** osascript'e `-e` ile verilen sabit betik. Hiçbir çağrıda içeriği değişmez. */
export const COMPUTER_INPUT_JXA = String.raw`
ObjC.import('Cocoa');
ObjC.import('CoreGraphics');

function readRequest() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return JSON.parse(ObjC.unwrap(text));
}

function sleep(ms) { $.usleep(ms * 1000); }
function post(event) { $.CGEventPost(0, event); }

const frame = $.NSScreen.screens.objectAtIndex(0).frame;
const width = frame.size.width;
const height = frame.size.height;

function checkPoint(x, y) {
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
    throw new Error('Coordinates must be finite numbers.');
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('Coordinates are outside the screen.');
  }
}

function mouseEvent(type, x, y, button) {
  return $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button);
}

function keyEvent(keyCode, down, flags) {
  if (!Number.isInteger(keyCode) || keyCode < 0 || keyCode > 127) {
    throw new Error('Invalid key code.');
  }
  const event = $.CGEventCreateKeyboardEvent($(), keyCode, down);
  if (flags) $.CGEventSetFlags(event, flags);
  return event;
}

function tapKey(keyCode, flags) {
  post(keyEvent(keyCode, true, flags));
  sleep(12);
  post(keyEvent(keyCode, false, flags));
}

function typeCharacter(character) {
  const units = [];
  for (let i = 0; i < character.length; i++) units.push(character.charCodeAt(i));
  const down = keyEvent(0, true, 0);
  $.CGEventKeyboardSetUnicodeString(down, units.length, units);
  post(down);
  const up = keyEvent(0, false, 0);
  $.CGEventKeyboardSetUnicodeString(up, units.length, units);
  post(up);
}

// Dikkat: "run" adı JXA'da örtük giriş noktasıdır (iki kez çalışırdı); bu yüzden "execute".
function execute() {
  const request = readRequest();
  switch (request.action) {
    case 'info':
      return { width: width, height: height, scale: $.NSScreen.screens.objectAtIndex(0).backingScaleFactor };
    case 'move': {
      checkPoint(request.x, request.y);
      post(mouseEvent(5, request.x, request.y, 0));
      return {};
    }
    case 'click': {
      checkPoint(request.x, request.y);
      const right = request.button === 'right';
      const down = right ? 3 : 1;
      const up = right ? 4 : 2;
      const button = right ? 1 : 0;
      post(mouseEvent(5, request.x, request.y, 0));
      sleep(30);
      const count = request.clicks === 2 ? 2 : 1;
      for (let i = 1; i <= count; i++) {
        const pressed = mouseEvent(down, request.x, request.y, button);
        $.CGEventSetIntegerValueField(pressed, 1, i);
        post(pressed);
        sleep(25);
        const released = mouseEvent(up, request.x, request.y, button);
        $.CGEventSetIntegerValueField(released, 1, i);
        post(released);
        sleep(40);
      }
      return {};
    }
    case 'drag': {
      checkPoint(request.fromX, request.fromY);
      checkPoint(request.toX, request.toY);
      post(mouseEvent(5, request.fromX, request.fromY, 0));
      sleep(30);
      post(mouseEvent(1, request.fromX, request.fromY, 0));
      sleep(60);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = request.fromX + ((request.toX - request.fromX) * i) / steps;
        const y = request.fromY + ((request.toY - request.fromY) * i) / steps;
        post(mouseEvent(6, x, y, 0));
        sleep(15);
      }
      post(mouseEvent(2, request.toX, request.toY, 0));
      return {};
    }
    case 'type': {
      if (typeof request.text !== 'string') throw new Error('Invalid text.');
      for (const character of Array.from(request.text)) {
        if (character === '\n' || character === '\r') tapKey(36, 0);
        else if (character === '\t') tapKey(48, 0);
        else typeCharacter(character);
        sleep(8);
      }
      return {};
    }
    case 'key': {
      tapKey(request.keyCode, Number.isInteger(request.flags) ? request.flags : 0);
      return {};
    }
    default:
      throw new Error('Unknown action.');
  }
}

let output;
try {
  output = Object.assign({ ok: true }, execute());
} catch (error) {
  output = { ok: false, error: String(error && error.message ? error.message : error) };
}
JSON.stringify(output);
`;
