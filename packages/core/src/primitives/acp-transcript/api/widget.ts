import { z } from 'zod';

/** Ajanların gördüğü MCP sunucu adı; `show_widget` aracını sunar. */
export const WIDGET_MCP_SERVER_NAME = 'orkestra-widgets';
export const WIDGET_TOOL_NAME = 'show_widget';

/** Başlık uzunluğu üst sınırı (karakter). */
export const WIDGET_MAX_TITLE_LENGTH = 80;
/** Başlık + içerik için UTF-8 bayt üst sınırı (toplam 200 KB). */
export const WIDGET_MAX_BYTES = 200 * 1024;

/**
 * Sohbet içinde çizilen widget'ın girdisi. `html` ve `svg` alanlarından tam biri bulunur.
 * Araç çağrısının girdisi transcript'te bu şekliyle tutulur; böylece geçmiş yeniden yüklenince
 * widget ayrı bir depolama olmadan çizilebilir.
 */
export const transcriptWidgetSchema = z.object({
  title: z.string(),
  html: z.string().optional(),
  svg: z.string().optional(),
});

export type TranscriptWidget = z.infer<typeof transcriptWidgetSchema>;

export type WidgetValidation =
  | { success: true; data: TranscriptWidget }
  | { success: false; error: string };

const encoder = new TextEncoder();

/**
 * `show_widget` girdisini doğrular: başlık (1-80 karakter), tam olarak bir `html` ya da `svg`
 * metni ve toplam boyut sınırı. Ajan verisi güvenilmezdir; geçen değerler normalize edilir.
 */
export function validateWidgetInput(input: unknown): WidgetValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { success: false, error: 'Girdi bir nesne olmalı: { title, html | svg }.' };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.title !== 'string') {
    return { success: false, error: 'title alanı metin olmalı.' };
  }
  const title = raw.title.trim();
  if (title.length === 0) return { success: false, error: 'title boş olamaz.' };
  if (title.length > WIDGET_MAX_TITLE_LENGTH) {
    return {
      success: false,
      error: `title en fazla ${WIDGET_MAX_TITLE_LENGTH} karakter olabilir.`,
    };
  }
  const hasHtml = raw.html !== undefined && raw.html !== null;
  const hasSvg = raw.svg !== undefined && raw.svg !== null;
  if (hasHtml === hasSvg) {
    return { success: false, error: 'html ve svg alanlarından tam biri verilmeli.' };
  }
  const field = hasHtml ? 'html' : 'svg';
  const content = hasHtml ? raw.html : raw.svg;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { success: false, error: `${field} alanı boş olmayan bir metin olmalı.` };
  }
  const bytes = encoder.encode(title).length + encoder.encode(content).length;
  if (bytes > WIDGET_MAX_BYTES) {
    return {
      success: false,
      error: `Widget en fazla ${WIDGET_MAX_BYTES / 1024} KB olabilir (gönderilen: ${Math.ceil(bytes / 1024)} KB).`,
    };
  }
  return { success: true, data: hasHtml ? { title, html: content } : { title, svg: content } };
}

/**
 * Bir araç çağrısı adının Orkestra widget aracı olup olmadığı. Sağlayıcılar MCP araç adını farklı
 * yazar (`mcp__orkestra-widgets__show_widget`, `mcp.orkestra-widgets.show_widget`, ...); ad hem
 * sunucuyu hem aracı içermelidir.
 */
export function isWidgetToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes(WIDGET_MCP_SERVER_NAME) && lower.includes(WIDGET_TOOL_NAME);
}

/** MCP çağrısı `server` ve `tool` alanlarını ayrı veriyorsa aynı kural. */
export function isWidgetMcpCall(call: { server?: string; tool: string }): boolean {
  if (call.server !== undefined) {
    return call.server === WIDGET_MCP_SERVER_NAME && call.tool.trim().endsWith(WIDGET_TOOL_NAME);
  }
  return isWidgetToolName(call.tool);
}

/**
 * ACP `rawInput` değerinden widget girdisini çıkarır. Bazı bağdaştırıcılar MCP argümanlarını
 * `{ server, tool, arguments }` içinde sarar. Doğrulanamayan değer `undefined` döner.
 */
export function extractWidgetInput(rawInput: unknown): TranscriptWidget | undefined {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    return undefined;
  }
  const record = rawInput as Record<string, unknown>;
  const candidate =
    typeof record.arguments === 'object' && record.arguments !== null ? record.arguments : rawInput;
  const result = validateWidgetInput(candidate);
  return result.success ? result.data : undefined;
}
