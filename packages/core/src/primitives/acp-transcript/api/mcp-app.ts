// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/shared/src/mcpApp.ts
import { z } from 'zod';

/**
 * MCP Apps (https://github.com/modelcontextprotocol/ext-apps) için paylaşılan sabitler ve saf
 * yardımcılar. Bir MCP aracı `_meta.ui.resourceUri` ile `ui://` kaynağına işaret ederse, Orkestra
 * o kaynağın HTML'ini sohbette araç çağrısının altında korumalı bir çerçevede gösterir.
 */

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_RESOURCE_SCHEME = 'ui://';

const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Transcript'te tutulan araç girdisi için üst sınır (JSON bayt). */
export const MCP_CALL_MAX_INPUT_BYTES = 64 * 1024;
/** Transcript'te tutulan araç sonucu için üst sınır (JSON bayt). */
export const MCP_CALL_MAX_RESULT_BYTES = 256 * 1024;

const MAX_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_RESOURCE_URI_LENGTH = 4096;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ── Transcript'te tutulan MCP çağrısı ────────────────────────────────────────

export const transcriptMcpCallResultSchema = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Bir MCP araç çağrısının kimliği ve (boyut sınırı içindeyse) girdisi/sonucu. Yalnızca sağlayıcı
 * çağrının hangi MCP sunucusuna ait olduğunu bildirdiğinde tutulur; MCP uygulaması bu değerleri
 * `ui/notifications/tool-input` ve `tool-result` ile okur. `server`, sağlayıcının yazdığı addır
 * (Claude Code adı `[A-Za-z0-9_-]` dışındaki karakterleri `_` yapar).
 */
export const transcriptMcpCallSchema = z.object({
  server: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: transcriptMcpCallResultSchema.optional(),
});

export type TranscriptMcpCallResult = z.infer<typeof transcriptMcpCallResultSchema>;
export type TranscriptMcpCall = z.infer<typeof transcriptMcpCallSchema>;
/** Kimliği olmayan kısmi güncelleme (ör. yalnızca sonuç). */
export type TranscriptMcpCallPatch = Partial<TranscriptMcpCall>;

/** Orkestra'nın kendi araç sunucuları uygulama sunmaz; girdileri transcript'e taşınmaz. */
function isOrkestraServer(server: string): boolean {
  return /^orkestra($|[-_])/i.test(server);
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : encoder.encode(json).byteLength;
  } catch {
    return undefined;
  }
}

function boundedRecord(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const bytes = jsonBytes(value);
  return bytes !== undefined && bytes <= maxBytes ? value : undefined;
}

/** Sağlayıcıların sonuç biçimlerini MCP `CallToolResult` şekline getirir. */
export function normalizeMcpCallResult(
  raw: unknown,
  failed = false
): TranscriptMcpCallResult | undefined {
  let result: TranscriptMcpCallResult | undefined;
  if (Array.isArray(raw)) {
    result = { content: raw };
  } else if (typeof raw === 'string') {
    result = { content: [{ type: 'text', text: raw }] };
  } else if (isObject(raw)) {
    // codex-acp: `{ result: CallToolResult | null, error: { message } | null }`
    if ('result' in raw || 'error' in raw) {
      if (isObject(raw.result)) return normalizeMcpCallResult(raw.result, failed);
      if (isObject(raw.error) && typeof raw.error.message === 'string') {
        result = { content: [{ type: 'text', text: raw.error.message }], isError: true };
      } else {
        return undefined;
      }
    } else if (Array.isArray(raw.content)) {
      result = {
        content: raw.content,
        ...(isObject(raw.structuredContent) ? { structuredContent: raw.structuredContent } : {}),
        ...(raw.isError === true ? { isError: true } : {}),
        ...(isObject(raw._meta) ? { _meta: raw._meta } : {}),
      };
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (failed && result.isError !== true) result = { ...result, isError: true };
  const bytes = jsonBytes(result);
  return bytes !== undefined && bytes <= MCP_CALL_MAX_RESULT_BYTES ? result : undefined;
}

/** `mcp__<server>__<tool>` (Claude Code ve benzerleri). */
export function parsePrefixedMcpToolName(
  name: string | null | undefined
): { server: string; tool: string } | undefined {
  if (typeof name !== 'string') return undefined;
  const match = /^mcp__(.+?)__(.+)$/.exec(name.trim());
  if (!match) return undefined;
  const [, server, tool] = match;
  if (!server || !tool) return undefined;
  return { server, tool };
}

/**
 * Ham ACP `tool_call`/`tool_call_update` güncellemesinden MCP çağrısını çıkarır. Kimlik aynı
 * güncellemede bulunmazsa (ör. yalnızca durum değişimi) `undefined` döner; böylece MCP olmayan
 * araçların girdisi/çıktısı transcript'e asla taşınmaz.
 *
 * - codex-acp: `rawInput: { server, tool, arguments }`, `rawOutput: { result, error }`,
 *   `_meta.is_mcp_tool_call`.
 * - claude-agent-acp: `_meta.claudeCode.toolName = mcp__<server>__<tool>`, `rawInput` araç
 *   argümanları, `rawOutput` MCP içerik blokları.
 * - Diğerleri: başlık ya da ad `mcp__<server>__<tool>` biçimindeyse.
 */
export function extractMcpCall(update: unknown): TranscriptMcpCallPatch | undefined {
  if (!isObject(update)) return undefined;
  const meta = isObject(update._meta) ? update._meta : {};
  const rawInput = update.rawInput;
  const status = update.status;
  const failed = status === 'failed';
  const hasOutput = Object.prototype.hasOwnProperty.call(update, 'rawOutput');

  let identity: { server: string; tool: string } | undefined;
  let input: unknown;

  if (
    isObject(rawInput) &&
    typeof rawInput.server === 'string' &&
    typeof rawInput.tool === 'string' &&
    (meta.is_mcp_tool_call === true ||
      (typeof update.title === 'string' && update.title.startsWith('mcp.')))
  ) {
    identity = { server: rawInput.server, tool: rawInput.tool };
    input = rawInput.arguments;
  } else {
    const claude = isObject(meta.claudeCode) ? meta.claudeCode : undefined;
    identity =
      parsePrefixedMcpToolName(
        typeof claude?.toolName === 'string' ? claude.toolName : undefined
      ) ??
      parsePrefixedMcpToolName(typeof update.name === 'string' ? update.name : undefined) ??
      parsePrefixedMcpToolName(typeof update.title === 'string' ? update.title : undefined);
    input = rawInput;
  }

  if (identity === undefined) return undefined;
  if (identity.server.length > MAX_NAME_LENGTH || identity.tool.length > MAX_NAME_LENGTH) {
    return undefined;
  }
  if (isOrkestraServer(identity.server)) return undefined;

  const boundedInput = boundedRecord(input, MCP_CALL_MAX_INPUT_BYTES);
  const result = hasOutput ? normalizeMcpCallResult(update.rawOutput, failed) : undefined;
  return {
    server: identity.server,
    tool: identity.tool,
    ...(boundedInput !== undefined ? { input: boundedInput } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

/**
 * Önceki değerle yeni güncellemeyi birleştirir. Kimlik ilk bildirilen değerde sabit kalır;
 * girdi ve sonuç yalnızca yeni değer geldiğinde değişir.
 */
export function mergeMcpCall(
  previous: TranscriptMcpCall | undefined,
  patch: TranscriptMcpCallPatch | undefined
): TranscriptMcpCall | undefined {
  if (patch === undefined) return previous;
  const server = previous?.server ?? patch.server;
  const tool = previous?.tool ?? patch.tool;
  if (server === undefined || tool === undefined) return previous;
  const input = patch.input ?? previous?.input;
  const result = patch.result ?? previous?.result;
  return {
    server,
    tool,
    ...(input !== undefined ? { input } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

// ── Uygulama kaynağı (snapshot) ve güvenlik politikası ──────────────────────────

export interface McpAppCsp {
  readonly connectDomains?: ReadonlyArray<string>;
  readonly resourceDomains?: ReadonlyArray<string>;
  readonly frameDomains?: ReadonlyArray<string>;
  readonly baseUriDomains?: ReadonlyArray<string>;
}

export interface McpAppPermissions {
  readonly camera?: Record<string, never>;
  readonly microphone?: Record<string, never>;
  readonly geolocation?: Record<string, never>;
  readonly clipboardWrite?: Record<string, never>;
}

export const mcpAppCspSchema = z.object({
  connectDomains: z.array(z.string()).optional(),
  resourceDomains: z.array(z.string()).optional(),
  frameDomains: z.array(z.string()).optional(),
  baseUriDomains: z.array(z.string()).optional(),
});

export const mcpAppPermissionsSchema = z.object({
  camera: z.object({}).strict().optional(),
  microphone: z.object({}).strict().optional(),
  geolocation: z.object({}).strict().optional(),
  clipboardWrite: z.object({}).strict().optional(),
});

// Yalnızca şema içeren, isteğe bağlı alt alan joker karakterli kökenler: politika genişletilemez.
const DOMAIN_PATTERN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

function readDomains(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .filter(
      (domain): domain is string =>
        typeof domain === 'string' &&
        domain.length <= MAX_DOMAIN_LENGTH &&
        DOMAIN_PATTERN.test(domain)
    )
    .slice(0, MAX_DOMAINS);
  return domains.length === 0 ? undefined : domains;
}

/** Kaynağın `_meta.ui.csp` alanını doğrular; geçersiz alan adları sessizce atılır. */
export function readMcpAppCsp(value: unknown): McpAppCsp | undefined {
  if (!isObject(value)) return undefined;
  const csp: {
    connectDomains?: ReadonlyArray<string>;
    resourceDomains?: ReadonlyArray<string>;
    frameDomains?: ReadonlyArray<string>;
    baseUriDomains?: ReadonlyArray<string>;
  } = {};
  for (const key of [
    'connectDomains',
    'resourceDomains',
    'frameDomains',
    'baseUriDomains',
  ] as const) {
    const domains = readDomains(value[key]);
    if (domains !== undefined) csp[key] = domains;
  }
  return Object.keys(csp).length === 0 ? undefined : csp;
}

const PERMISSION_KEYS = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const;

export function readMcpAppPermissions(value: unknown): McpAppPermissions | undefined {
  if (!isObject(value)) return undefined;
  const permissions: Partial<Record<(typeof PERMISSION_KEYS)[number], Record<string, never>>> = {};
  for (const key of PERMISSION_KEYS) {
    if (isObject(value[key])) permissions[key] = {};
  }
  return Object.keys(permissions).length === 0 ? undefined : permissions;
}

/** Aracın `_meta.ui.resourceUri` değerini (ya da eski düz `ui/resourceUri`) okur. */
export function mcpAppToolResourceUri(meta: unknown): string | undefined {
  if (!isObject(meta)) return undefined;
  const uri = (isObject(meta.ui) ? meta.ui.resourceUri : undefined) ?? meta['ui/resourceUri'];
  return typeof uri === 'string' &&
    uri.length <= MAX_RESOURCE_URI_LENGTH &&
    uri.startsWith(MCP_APP_RESOURCE_SCHEME)
    ? uri
    : undefined;
}

/** `_meta.ui.visibility` varsa ve `app` içermiyorsa uygulama bu aracı çağıramaz. */
export function mcpAppToolCallableByApp(meta: unknown): boolean {
  const visibility = isObject(meta) && isObject(meta.ui) ? meta.ui.visibility : undefined;
  return !Array.isArray(visibility) || visibility.includes('app');
}

/** MCP aracı `annotations.readOnlyHint === true` ise salt okunurdur. */
export function mcpToolIsReadOnly(tool: unknown): boolean {
  return isObject(tool) && isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
}

export function mcpToolTitle(tool: unknown): string | undefined {
  if (!isObject(tool)) return undefined;
  if (isObject(tool.annotations) && typeof tool.annotations.title === 'string') {
    return tool.annotations.title;
  }
  return typeof tool.title === 'string' ? tool.title : undefined;
}

/** Claude Code araç adında sunucu adı `[a-zA-Z0-9_-]` dışındaki karakterleri `_` yapar. */
export const claudeMcpToolNamePart = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Sağlayıcının yazdığı sunucu adının yapılandırmadaki ada karşılık gelip gelmediği: birebir ya da
 * Claude Code'un dönüştürdüğü biçimde.
 */
export function mcpServerNameMatches(configured: string, reported: string): boolean {
  if (configured === reported) return true;
  const part = claudeMcpToolNamePart(configured);
  if (part === reported) return true;
  // claude.ai bağlayıcılarında ardışık `_` daraltılır ve baştaki/sondaki `_` atılır.
  return part.replace(/_+/g, '_').replace(/^_|_$/g, '') === reported;
}

/**
 * `resources/read` içeriklerinden uygulama belgesini seçer. Boyut sınırını aşan belge için
 * `html: null` döner.
 */
export function readMcpAppDocument(
  contents: ReadonlyArray<unknown>,
  uri: string
): { readonly html: string | null; readonly meta: unknown } | undefined {
  for (const content of contents) {
    if (!isObject(content)) continue;
    if (content.uri !== undefined && content.uri !== uri) continue;
    const mimeType = typeof content.mimeType === 'string' ? content.mimeType : '';
    if (mimeType.replace(/\s+/g, '').toLowerCase() !== MCP_APP_MIME_TYPE) continue;
    // Kopyalamadan önce sınırla: UTF-8 en az metin uzunluğu kadar, base64 3/4'e açılır.
    const html =
      typeof content.text === 'string'
        ? content.text.length > MCP_APP_MAX_HTML_BYTES
          ? null
          : content.text
        : typeof content.blob === 'string'
          ? content.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4
            ? null
            : decodeBase64Utf8(content.blob)
          : undefined;
    if (html === null) return { html: null, meta: undefined };
    if (html === undefined || html.trim() === '') continue;
    if (encoder.encode(html).byteLength > MCP_APP_MAX_HTML_BYTES) {
      return { html: null, meta: undefined };
    }
    const meta = isObject(content._meta) ? content._meta.ui : undefined;
    return { html, meta };
  }
  return undefined;
}

function decodeBase64Utf8(value: string): string | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Uygulamanın belge CSP'si. Bildirilmemiş kökenler (Orkestra'nın kendi kökeni dahil) engellenir;
 * ağ yalnızca kaynağın bildirdiği `connectDomains`, dış dosyalar yalnızca `resourceDomains`.
 */
export function mcpAppContentSecurityPolicy(csp: McpAppCsp | undefined): string {
  // Kayıttan gelen değer de yeniden doğrulanır: politika yalnızca geçerli kökenlerle genişler.
  const checked = readMcpAppCsp(csp);
  const resources = checked?.resourceDomains?.join(' ') ?? '';
  const list = (domains: ReadonlyArray<string> | undefined, fallback: string) =>
    domains === undefined || domains.length === 0 ? fallback : domains.join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(checked?.connectDomains, "'none'")}`,
    // blob: çerçeve, uygulamanın elindeki HTML'i taşır; aynı opak köken, sandbox ve politikayı alır.
    `frame-src blob: ${checked?.frameDomains?.join(' ') ?? ''}`.trim(),
    "object-src 'none'",
    `base-uri ${list(checked?.baseUriDomains, "'none'")}`,
    "form-action 'none'",
  ].join('; ');
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * CSP `<meta>` etiketini belgenin en başına (doctype'tan hemen sonra) koyar; uygulamanın hiçbir
 * betiği ondan önce çalışamaz.
 */
export function injectMcpAppCsp(html: string, csp: McpAppCsp | undefined): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
    mcpAppContentSecurityPolicy(csp)
  )}">`;
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}`
    : `<!doctype html>${meta}${html}`;
}

/** CSP etiketinden hemen sonra (uygulama betiklerinden önce) bir betik ekler. */
export function injectAfterMcpAppCsp(html: string, script: string): string {
  const prefix =
    /^(?:﻿?\s*<!doctype[^>]*>\s*)?(?:<meta http-equiv="Content-Security-Policy" content="[^"]*">)?/i.exec(
      html
    )?.[0] ?? '';
  return `${prefix}${script}${html.slice(prefix.length)}`;
}

export function mcpAppAllowAttribute(permissions: McpAppPermissions | undefined): string {
  const features: string[] = [];
  if (permissions?.camera) features.push('camera');
  if (permissions?.microphone) features.push('microphone');
  if (permissions?.geolocation) features.push('geolocation');
  if (permissions?.clipboardWrite) features.push('clipboard-write');
  return features.join('; ');
}

export function clampMcpAppHeight(height: number): number {
  if (!Number.isFinite(height)) return MCP_APP_DEFAULT_HEIGHT;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, height)));
}
