type FakeDocument = unknown;
export type SnapshotElement = {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  name: string;
  placeholder?: string;
  contentEditable?: boolean;
  disabled?: boolean;
  forbidden?: boolean;
  href?: string;
  checked?: boolean;
  value?: string;
};
export type PageSnapshot = {
  url: string;
  title: string;
  text: string;
  pageText: string;
  truncated: boolean;
  elements: SnapshotElement[];
  tree: string;
};
export type FindMatch = {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  rect?: { x: number; y: number; width: number; height: number };
};
export type PageActionResult = {
  ok: true;
  [key: string]: unknown;
} | {
  ok: false;
  code: string;
  message?: string;
};
export function snapshotPage(
  optionsOrMaxChars?:
    | number
    | {
        maxChars?: number;
        filter?: 'interactive' | 'all';
        rootRef?: string;
        maxElements?: number;
      },
  doc?: FakeDocument
): PageSnapshot;
export function findInPage(
  options?: { query?: string; selector?: string; role?: string; limit?: number },
  doc?: FakeDocument
): { ok: true; url: string; title: string; matches: FindMatch[] } | { ok: false; code: string; message?: string };
export function getPageText(
  options?: { selector?: string; ref?: string; maxChars?: number },
  doc?: FakeDocument
):
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; code: string; message?: string };
export function clickRef(
  targetOrOptions:
    | string
    | {
        ref?: string;
        selector?: string;
        x?: number;
        y?: number;
        button?: 'left' | 'right' | 'middle';
        double?: boolean;
      },
  doc?: FakeDocument
): PageActionResult;
export function typeRef(
  refOrOptions: string | { ref: string; text: string; clear?: boolean; submit?: boolean },
  text?: string,
  submit?: boolean,
  doc?: FakeDocument
): PageActionResult;
export function formInputRef(
  options: { ref: string; value: string | boolean | number },
  doc?: FakeDocument
): PageActionResult;
export function pressKeyInPage(
  options: { key: string; ref?: string; modifiers?: string[] },
  doc?: FakeDocument
): PageActionResult;
export function scrollPage(
  options?: {
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    ref?: string;
    toRef?: string;
  },
  doc?: FakeDocument
): PageActionResult;
export function evaluateInPage(
  expression: string,
  win?: unknown
): Promise<
  | { ok: true; result: unknown; type: string }
  | { ok: false; code: string; message?: string }
>;
export function checkWaitCondition(
  options?: { text?: string; textGone?: string; selector?: string; selectorGone?: string },
  doc?: FakeDocument
): { ok: true; matched: boolean } | { ok: false; code: string; message?: string };
export function readConsolePage(
  options?: { level?: 'all' | 'log' | 'info' | 'warn' | 'error'; limit?: number; clear?: boolean },
  win?: unknown
): { ok: true; entries: Array<Record<string, unknown>> };
export function readNetworkPage(
  options?: {
    urlFilter?: string;
    method?: string;
    status?: number;
    limit?: number;
    clear?: boolean;
  },
  win?: unknown
): { ok: true; requests: Array<Record<string, unknown>> };
