import {
  WIDGET_MAX_BYTES,
  WIDGET_MAX_TITLE_LENGTH,
  WIDGET_MCP_SERVER_NAME,
  WIDGET_TOOL_NAME,
} from '@orkestra/core/runtimes/acp/api/client';

/** Ajanların ACP oturumunda gördüğü MCP sunucu adı. */
export const WIDGET_SERVER_NAME = WIDGET_MCP_SERVER_NAME;

/** Paylaşılan RPC sunucusunda widget araçlarının kimliği (`ORKESTRA_TOOLS_SERVER`). */
export const WIDGET_TOOLS_SERVER_ID = 'widgets';

/** Sunucunun MCP `instructions` metni; ajanın sistem bağlamına eklenir. */
export const WIDGET_TOOLS_INSTRUCTIONS = [
  'Orkestra inline widgets. show_widget draws a small visual or interactive HTML/SVG block directly in the chat transcript, for the user to look at or play with (a chart, a diagram, a calculator, a mini form).',
  `- Pass title (at most ${WIDGET_MAX_TITLE_LENGTH} characters) and exactly one of html or svg; at most ${WIDGET_MAX_BYTES / 1024} KB in total.`,
  "- The widget runs in a locked-down sandbox: scripts and inline styles work, but there is no network, no external file, font or image (use data: URIs), no access to the app or the user's files, and it cannot send messages back to the chat.",
  '- Write a self-contained fragment. Use the CSS variables --widget-bg, --widget-fg, --widget-muted, --widget-border and --widget-accent so the widget matches the light or dark theme.',
  '- A widget is a visual aid, not a place to put the answer: also explain the result in your message.',
].join('\n');

export const PREVIEW_WIDGET_TOOL_NAME = 'preview_widget';

/** Widget araçlarının JSON Schema tanımları ve MCP açıklama ipuçları. */
export const WIDGET_TOOLS = [
  {
    name: WIDGET_TOOL_NAME,
    description:
      'Show an inline HTML or SVG widget in the conversation, in a sandboxed frame without network access. Give exactly one of html or svg. Returns once the widget has been handed to the chat.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          maxLength: WIDGET_MAX_TITLE_LENGTH,
          description: 'Short title shown above the widget.',
        },
        html: {
          type: 'string',
          description:
            'Self-contained HTML fragment (inline <style> and <script> allowed). Do not combine with svg.',
        },
        svg: {
          type: 'string',
          description: 'A complete <svg> element. Do not combine with html.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Show widget', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: PREVIEW_WIDGET_TOOL_NAME,
    description:
      'Render an HTML or SVG widget offscreen in an isolated sandbox and return a PNG screenshot, measured contentHeight, and console messages so you can visually verify layout before calling show_widget. Local absolute <img src> paths are magic-byte verified and inlined automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Self-contained HTML fragment.' },
        svg: { type: 'string', description: 'Complete <svg> element.' },
        width: { type: 'number', description: 'Viewport width in CSS pixels (240..1400, default 728).' },
        appearance: { type: 'string', enum: ['dark', 'light'], description: 'Theme appearance (default dark).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Preview widget offscreen', readOnlyHint: true, openWorldHint: false },
  },
] as const;
