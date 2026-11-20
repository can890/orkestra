export const PROTOCOL_VERSION: number;
export const SUBPROTOCOL: string;
export const TOKEN_SUBPROTOCOL_PREFIX: string;
export const DEFAULT_PORT: number;
export const ACTIONS: readonly string[];
export const MAX_TEXT_CHARS: number;
export const MAX_TYPE_CHARS: number;
export const MAX_URL_LENGTH: number;
export const MAX_EVAL_CHARS: number;
export const ERROR_CODES: {
  readonly siteNotPermitted: string;
  readonly unsupportedPage: string;
  readonly forbiddenField: string;
  readonly noSuchTab: string;
  readonly noSuchElement: string;
  readonly failed: string;
};
export type BridgeRequest = { id: string; action: string; params: Record<string, unknown> };
export function isSupportedPageUrl(value: unknown): boolean;
export function originPattern(value: unknown): string | null;
export function isUrlPermitted(url: unknown, grantedOrigins?: readonly string[]): boolean;
export function isForbiddenField(
  field:
    | { tag?: string; type?: string; autocomplete?: string; name?: string; id?: string }
    | null
    | undefined
): boolean;
export function isElementRef(value: unknown): boolean;
export function parseServerMessage(
  raw: unknown
):
  | { ok: true; kind: 'ping' }
  | { ok: true; kind: 'welcome' }
  | { ok: true; kind: 'request'; request: BridgeRequest }
  | { ok: false; reason: string };
export function validateParams(
  action: string,
  params: Record<string, unknown>
): { ok: true; params: Record<string, unknown> } | { ok: false; reason: string };
export function siteNotPermittedMessage(origin: string): string;
export function buildConnection(settings?: {
  token?: unknown;
  port?: unknown;
}): { url: string; protocols: string[] } | null;
