type FakeDocument = unknown;
export type SnapshotElement = {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  name: string;
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
  truncated: boolean;
  elements: SnapshotElement[];
};
export type PageActionResult = { ok: true } | { ok: false; code: string; message?: string };
export function snapshotPage(maxChars: number, doc?: FakeDocument): PageSnapshot;
export function clickRef(ref: string, doc?: FakeDocument): PageActionResult;
export function typeRef(
  ref: string,
  text: string,
  submit: boolean,
  doc?: FakeDocument
): PageActionResult;
