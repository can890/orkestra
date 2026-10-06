import type {
  BrowserElementLocator,
  BrowserKeyModifier,
  BrowserRecordedStep,
} from './agent-browser';

/**
 * Kayıt adımlarının doğrulanması ve okunur özeti. Hem ana süreç (sayfadan gelen kullanıcı
 * adımları) hem ajan araçları (replay girdisi) güvenilmeyen JSON'u buradan geçirir.
 */

export const MAX_RECORDED_STEPS = 500;
const SELECTOR_MAX = 1_000;
const TEXT_MAX = 100_000;
const LABEL_MAX = 200;
const URL_MAX = 8_192;
const KEY_MAX = 100;
const MAX_WAIT_MS = 60_000;
const BUTTONS = ['left', 'right', 'middle'] as const;
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const MODIFIERS: readonly BrowserKeyModifier[] = ['shift', 'control', 'alt', 'meta'];

export type RecordedStepParseResult =
  | { ok: true; step: BrowserRecordedStep }
  | { ok: false; error: string };

/** Tek bir adımı doğrular ve fazlalık alanlardan arındırılmış kopyasını döndürür. */
export function parseRecordedStep(value: unknown): RecordedStepParseResult {
  try {
    return { ok: true, step: parseStep(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Adım listesini doğrular; dizi ya da JSON metni kabul eder. Hata, adım numarasını içerir. */
export function parseRecordedSteps(value: unknown): BrowserRecordedStep[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('steps must be an array of step objects or its JSON text.');
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = (raw as { steps?: unknown }).steps;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('steps must be a non-empty array of step objects.');
  }
  if (raw.length > MAX_RECORDED_STEPS) {
    throw new Error(`steps may contain at most ${MAX_RECORDED_STEPS} steps.`);
  }
  return raw.map((item, index) => {
    const result = parseRecordedStep(item);
    if (!result.ok) throw new Error(`Step ${index + 1}: ${result.error}`);
    return result.step;
  });
}

/** Adımın tek satırlık okunur özeti (ör. `click button.primary "Save"`). */
export function describeRecordedStep(step: BrowserRecordedStep): string {
  switch (step.action) {
    case 'navigate':
      return `navigate ${step.url}`;
    case 'back':
    case 'forward':
    case 'reload':
      return step.action;
    case 'click': {
      const prefix =
        (step.clickCount ?? 1) > 1
          ? 'double-click'
          : step.button && step.button !== 'left'
            ? `${step.button}-click`
            : 'click';
      return `${prefix} ${describeLocator(step.target)}`;
    }
    case 'type':
      return `type ${step.secret ? '(secret)' : JSON.stringify(truncate(step.text, 60))} into ${step.target ? describeLocator(step.target) : 'the focused element'}${step.submit ? ' and press Enter' : ''}`;
    case 'press':
      return `press ${step.key}`;
    case 'select':
      return `select ${step.values.map((value) => JSON.stringify(value)).join(', ')} in ${describeLocator(step.target)}`;
    case 'scroll':
      return `scroll ${step.direction}${step.amount !== undefined ? ` ${step.amount} px` : ''}${step.target ? ` in ${describeLocator(step.target)}` : ''}`;
    case 'wait':
      return [
        'wait',
        step.text !== undefined ? `for ${JSON.stringify(step.text)}` : null,
        step.textGone !== undefined ? `until ${JSON.stringify(step.textGone)} is gone` : null,
        step.ms !== undefined ? `${step.ms} ms` : null,
      ]
        .filter(Boolean)
        .join(' ');
  }
}

export function describeLocator(locator: BrowserElementLocator): string {
  return `${locator.selector}${locator.text ? ` ${JSON.stringify(truncate(locator.text, 60))}` : ''}`;
}

function parseStep(value: unknown): BrowserRecordedStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('each step must be an object with an "action".');
  }
  const record = value as Record<string, unknown>;
  switch (record.action) {
    case 'navigate':
      return { action: 'navigate', url: requiredString(record, 'url', URL_MAX) };
    case 'back':
    case 'forward':
    case 'reload':
      return { action: record.action };
    case 'click': {
      const step: Extract<BrowserRecordedStep, { action: 'click' }> = {
        action: 'click',
        target: locator(record.target, true),
      };
      const button = optionalEnum(record, 'button', BUTTONS);
      if (button && button !== 'left') step.button = button;
      const clickCount = optionalNumber(record, 'clickCount', 1, 3);
      if (clickCount !== undefined && clickCount > 1) step.clickCount = Math.floor(clickCount);
      const modifiers = optionalModifiers(record.modifiers);
      if (modifiers.length > 0) step.modifiers = modifiers;
      return step;
    }
    case 'type': {
      const secret = record.secret === true;
      const text = secret
        ? (optionalString(record, 'text', TEXT_MAX) ?? '')
        : requiredString(record, 'text', TEXT_MAX, true);
      const step: Extract<BrowserRecordedStep, { action: 'type' }> = { action: 'type', text };
      const target = locator(record.target, false);
      if (target) step.target = target;
      if (record.clear === true) step.clear = true;
      if (record.submit === true) step.submit = true;
      if (secret) step.secret = true;
      return step;
    }
    case 'press':
      return { action: 'press', key: requiredString(record, 'key', KEY_MAX) };
    case 'select': {
      const values = record.values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((item) => typeof item !== 'string' || item.length > LABEL_MAX * 10)
      ) {
        throw new Error('"values" must be a non-empty list of strings.');
      }
      return { action: 'select', target: locator(record.target, true), values: [...values] };
    }
    case 'scroll': {
      const direction = optionalEnum(record, 'direction', DIRECTIONS) ?? 'down';
      const step: Extract<BrowserRecordedStep, { action: 'scroll' }> = {
        action: 'scroll',
        direction,
      };
      const target = locator(record.target, false);
      if (target) step.target = target;
      const amount = optionalNumber(record, 'amount', 1, 1_000_000);
      if (amount !== undefined) step.amount = amount;
      return step;
    }
    case 'wait': {
      const step: Extract<BrowserRecordedStep, { action: 'wait' }> = { action: 'wait' };
      const text = optionalString(record, 'text', TEXT_MAX);
      const textGone = optionalString(record, 'textGone', TEXT_MAX);
      const ms = optionalNumber(record, 'ms', 0, MAX_WAIT_MS);
      if (text) step.text = text;
      if (textGone) step.textGone = textGone;
      if (ms !== undefined) step.ms = Math.round(ms);
      if (!step.text && !step.textGone && step.ms === undefined) {
        throw new Error('a wait step needs text, textGone or ms.');
      }
      return step;
    }
    default:
      throw new Error(
        `unknown action ${JSON.stringify(record.action)}; use navigate, back, forward, reload, click, type, press, select, scroll or wait.`
      );
  }
}

function locator(value: unknown, required: true): BrowserElementLocator;
function locator(value: unknown, required: boolean): BrowserElementLocator | undefined;
function locator(value: unknown, required: boolean): BrowserElementLocator | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error('"target" with a CSS selector is required.');
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"target" must be an object like { "selector": "#save", "text": "Save" }.');
  }
  const record = value as Record<string, unknown>;
  const selector = optionalString(record, 'selector', SELECTOR_MAX)?.trim() ?? '';
  const text = optionalString(record, 'text', LABEL_MAX)?.trim() ?? '';
  if (!selector && !text) throw new Error('"target" needs a selector or text.');
  return text ? { selector, text } : { selector };
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  max: number
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string.`);
  if (value.length > max) throw new Error(`"${key}" is too long (at most ${max} characters).`);
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  max: number,
  allowEmpty = false
): string {
  const value = optionalString(record, key, max);
  if (value === undefined || (!allowEmpty && value.trim() === '')) {
    throw new Error(`"${key}" is required.`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`"${key}" must be a number between ${min} and ${max}.`);
  }
  return value;
}

function optionalEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T
): T[number] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`"${key}" must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function optionalModifiers(value: unknown): BrowserKeyModifier[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('"modifiers" must be a list.');
  const result: BrowserKeyModifier[] = [];
  for (const item of value) {
    const modifier = MODIFIERS.find((candidate) => candidate === item);
    if (!modifier) throw new Error('"modifiers" may contain shift, control, alt and meta.');
    if (!result.includes(modifier)) result.push(modifier);
  }
  return result;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
