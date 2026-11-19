import { createEffect, onCleanup, onMount } from 'solid-js';
import { parseWidgetHeightMessage } from './widget-height';
import { setWidgetHeight, widgetHeight } from './widget-height-store';
import type { ChatWidget } from './widget-node';
import {
  WIDGET_SANDBOX,
  WIDGET_THEME_KEYS,
  WIDGET_THEME_MESSAGE,
  buildWidgetSrcdoc,
  sanitizeThemeColors,
  type WidgetThemeColors,
  type WidgetThemeKey,
} from './widget-srcdoc';
import { card, frame, header, probe, title as titleClass } from './widget.css';
import { vars } from '@styles/theme.css';

/** App theme tokens the widget receives; resolved to plain colours before they are injected. */
const THEME_SOURCES: Record<WidgetThemeKey, string> = {
  bg: vars.bg2,
  fg: vars.fgBody,
  muted: vars.fgMuted,
  border: vars.border,
  accent: vars.link,
};

/** Resolves the theme tokens to computed colours; only colour-shaped values survive. */
function resolveThemeColors(element: HTMLElement): WidgetThemeColors {
  const raw: Record<string, string> = {};
  for (const key of WIDGET_THEME_KEYS) {
    element.style.color = THEME_SOURCES[key];
    raw[key] = getComputedStyle(element).color;
  }
  element.style.color = '';
  return sanitizeThemeColors(raw);
}

/**
 * Inline widget: the agent's HTML or SVG in a sandboxed iframe (`allow-scripts` only, strict CSP
 * in the srcdoc). The widget has no channel to the app except the height message, which is
 * accepted only from this iframe's own window.
 */
export function Widget(props: { data: ChatWidget }) {
  let frameEl: HTMLIFrameElement | undefined;
  let probeEl: HTMLSpanElement | undefined;
  let colors: WidgetThemeColors = {};

  const pushTheme = () => {
    if (!probeEl) return;
    colors = resolveThemeColors(probeEl);
    // Host to widget only; the reporter script accepts it from `parent` exclusively.
    frameEl?.contentWindow?.postMessage({ type: WIDGET_THEME_MESSAGE, colors }, '*');
  };

  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      const height = parseWidgetHeightMessage(event, frameEl?.contentWindow);
      if (height !== null) setWidgetHeight(props.data.id, height);
    };
    window.addEventListener('message', onMessage);

    let pending = 0;
    const schedule = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(pushTheme);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', schedule);

    onCleanup(() => {
      window.removeEventListener('message', onMessage);
      observer.disconnect();
      media.removeEventListener('change', schedule);
      cancelAnimationFrame(pending);
    });
  });

  // The document is rebuilt only when the widget's own content changes.
  createEffect(() => {
    const { html, svg } = props.data;
    if (!frameEl || !probeEl) return;
    colors = resolveThemeColors(probeEl);
    frameEl.srcdoc = buildWidgetSrcdoc({ html, svg, colors });
  });

  return (
    <section class={card} aria-label={`Widget: ${props.data.title}`}>
      <div class={header}>
        <span class={titleClass} title={props.data.title}>
          {props.data.title}
        </span>
        <span>Widget</span>
      </div>
      <span
        class={probe}
        ref={(element) => {
          probeEl = element;
        }}
      />
      <iframe
        ref={(element) => {
          frameEl = element;
        }}
        class={frame}
        title={props.data.title}
        sandbox={WIDGET_SANDBOX}
        referrerPolicy="no-referrer"
        style={{ height: `${widgetHeight(props.data.id)()}px` }}
      />
    </section>
  );
}
