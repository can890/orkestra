import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
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
  const [zoomed, setZoomed] = createSignal(false);
  const [srcdoc, setSrcdoc] = createSignal('');

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && zoomed()) {
        setZoomed(false);
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);

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
      window.removeEventListener('keydown', onKeyDown);
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
    const nextDoc = buildWidgetSrcdoc({ html, svg, colors });
    setSrcdoc(nextDoc);
    frameEl.srcdoc = nextDoc;
  });

  return (
    <section class={card} aria-label={`Widget: ${props.data.title}`}>
      <div class={header}>
        <span class={titleClass} title={props.data.title}>
          {props.data.title}
        </span>
        <div style={{ display: 'inline-flex', 'align-items': 'center', gap: '8px' }}>
          <span>Widget</span>
          <button
            type="button"
            onClick={() => setZoomed(true)}
            title="Tam ekranda büyüt"
            aria-label="Tam ekranda büyüt"
            style={{
              background: 'transparent',
              border: `1px solid ${vars.border}`,
              color: vars.fgMuted,
              'border-radius': '4px',
              padding: '1px 6px',
              'font-size': '11px',
              cursor: 'pointer',
            }}
          >
            Büyüt
          </button>
        </div>
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
      <Show when={zoomed()}>
        <Portal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Tam ekran widget: ${props.data.title}`}
            onClick={(e) => {
              if (e.target === e.currentTarget) setZoomed(false);
            }}
            style={{
              position: 'fixed',
              inset: '0',
              'z-index': '9999',
              background: 'rgba(0, 0, 0, 0.72)',
              'backdrop-filter': 'blur(4px)',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '24px',
            }}
          >
            <div
              style={{
                width: 'min(1200px, 94vw)',
                height: 'min(860px, 90vh)',
                background: vars.bg1,
                border: `1px solid ${vars.border}`,
                'border-radius': '12px',
                display: 'flex',
                'flex-direction': 'column',
                overflow: 'hidden',
                'box-shadow': '0 24px 64px rgba(0,0,0,0.5)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'space-between',
                  padding: '10px 14px',
                  'border-bottom': `1px solid ${vars.border}`,
                  color: vars.fg,
                  'font-size': '13px',
                  'font-weight': '500',
                }}
              >
                <span>{props.data.title}</span>
                <button
                  type="button"
                  onClick={() => setZoomed(false)}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${vars.border}`,
                    color: vars.fg,
                    'border-radius': '6px',
                    padding: '4px 10px',
                    'font-size': '12px',
                    cursor: 'pointer',
                  }}
                >
                  Kapat (Esc)
                </button>
              </div>
              <iframe
                title={`${props.data.title} (Tam ekran)`}
                sandbox={WIDGET_SANDBOX}
                referrerPolicy="no-referrer"
                srcdoc={srcdoc()}
                style={{
                  flex: '1',
                  width: '100%',
                  border: 'none',
                  background: 'transparent',
                }}
              />
            </div>
          </div>
        </Portal>
      </Show>
    </section>
  );
}
