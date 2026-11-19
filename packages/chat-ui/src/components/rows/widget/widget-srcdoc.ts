/**
 * widget-srcdoc — builds the document an agent-written widget runs in.
 *
 * The agent's HTML is untrusted code running on the user's screen. Isolation does not depend on
 * parsing it: the iframe is sandboxed with `allow-scripts` only (opaque origin, no parent,
 * storage, popups, forms or top navigation) and the document starts with a strict CSP `<meta>`
 * (no network, no external resources). The agent's markup is placed after our `<head>` inside
 * `<body>`, so it can never come before the CSP; `<base>` and `<meta http-equiv>` tags are also
 * dropped as defense in depth.
 */

/** The iframe's `sandbox` attribute. Never add `allow-same-origin`, popups, forms or navigation. */
export const WIDGET_SANDBOX = 'allow-scripts';

/**
 * Strict profile: no `connect-src`, no external sources. `base-uri` and `form-action` are not
 * covered by `default-src`, so they are denied explicitly.
 */
export const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export type WidgetThemeKey = 'bg' | 'fg' | 'muted' | 'border' | 'accent';

export const WIDGET_THEME_KEYS: readonly WidgetThemeKey[] = [
  'bg',
  'fg',
  'muted',
  'border',
  'accent',
];

export type WidgetThemeColors = Partial<Record<WidgetThemeKey, string>>;

/** Message the host sends into the iframe when the app theme changes (host to widget only). */
export const WIDGET_THEME_MESSAGE = 'orkestra-widget-theme';

const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%\s/+-]{1,80}\)$/i;
const COLOR_FUNCTION_COLOR = /^color\((?:srgb|display-p3|srgb-linear) [0-9a-z.,%\s/+-]{1,80}\)$/i;
const COLOR_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True only for a plain colour value; anything that could carry other CSS is rejected. */
export function isSafeColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return false;
  return (
    trimmed === 'transparent' ||
    COLOR_HEX.test(trimmed) ||
    COLOR_FUNCTION.test(trimmed) ||
    COLOR_FUNCTION_COLOR.test(trimmed)
  );
}

/** Keeps only known keys whose value matches the colour pattern. */
export function sanitizeThemeColors(raw: Record<string, unknown>): WidgetThemeColors {
  const colors: WidgetThemeColors = {};
  for (const key of WIDGET_THEME_KEYS) {
    const value = raw[key];
    if (isSafeColorValue(value)) colors[key] = value.trim();
  }
  return colors;
}

function themeDeclarations(colors: WidgetThemeColors): string {
  return WIDGET_THEME_KEYS.flatMap((key) => {
    const value = colors[key];
    return isSafeColorValue(value) ? [`--widget-${key}:${value.trim()}`] : [];
  }).join(';');
}

/**
 * Drops `<base>` and `<meta http-equiv>` tags from agent markup. Quoted attribute values may
 * contain `>`, so tags are matched with quote awareness. This is not the security boundary.
 */
export function neutralizeDocumentTags(html: string): string {
  return html.replace(/<(base|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag, name: string) =>
    name.toLowerCase() === 'base' || /\bhttp-equiv\b/i.test(tag) ? '' : tag
  );
}

/**
 * Runs inside the widget: reports the content height to the host and applies theme updates sent by
 * the host (accepted only from `parent`). It is the first script of the document, so the agent's
 * markup cannot prevent it from running.
 */
const FRAME_SCRIPT = `(function(){
var last=0,keys=["bg","fg","muted","border","accent"];
function height(){var b=document.body,r=document.documentElement.getBoundingClientRect().height;return Math.ceil(Math.max(r,b?b.getBoundingClientRect().height:0));}
function report(){var h=height();if(h>0&&h!==last){last=h;try{parent.postMessage({type:"orkestra-widget-height",height:h},"*");}catch(e){}}}
window.addEventListener("message",function(e){
if(e.source!==parent)return;var d=e.data;
if(!d||d.type!=="${WIDGET_THEME_MESSAGE}"||!d.colors)return;
for(var i=0;i<keys.length;i++){var v=d.colors[keys[i]];if(typeof v==="string")document.documentElement.style.setProperty("--widget-"+keys[i],v);}
});
if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(report);ro.observe(document.documentElement);}
window.addEventListener("load",report);document.addEventListener("DOMContentLoaded",report);
setTimeout(report,50);setTimeout(report,400);
})();`;

const BASE_STYLE = `
:root{color-scheme:light dark;--widget-bg:#ffffff;--widget-fg:#1f2328;--widget-muted:#59636e;--widget-border:#d1d9e0;--widget-accent:#0969da}
@media (prefers-color-scheme:dark){:root{--widget-bg:#16181d;--widget-fg:#e6e8ec;--widget-muted:#9ba1ad;--widget-border:#2c3038;--widget-accent:#6cb0ff}}
html,body{margin:0;background:var(--widget-bg);color:var(--widget-fg)}
body{padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;overflow-wrap:anywhere}
svg{max-width:100%;height:auto}
`;

export type BuildWidgetSrcdocInput = {
  html?: string;
  svg?: string;
  colors?: WidgetThemeColors;
};

/**
 * Full srcdoc for a widget. Order is fixed: doctype, CSP meta (first element of `<head>`), our
 * styles and reporter script, `</head>`, then `<body>` with the agent's markup.
 */
export function buildWidgetSrcdoc(input: BuildWidgetSrcdocInput): string {
  const agentMarkup = neutralizeDocumentTags(input.svg ?? input.html ?? '');
  const overrides = themeDeclarations(input.colors ?? {});
  return [
    '<!doctype html>',
    '<html lang="tr"><head>',
    `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${BASE_STYLE}${overrides ? `:root{${overrides}}` : ''}</style>`,
    `<script>${FRAME_SCRIPT}</script>`,
    '</head><body>',
    agentMarkup,
    '</body></html>',
  ].join('');
}
