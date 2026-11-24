// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/chat/McpAppFrame.tsx
import { useCommands } from '@components/contexts/CommandsContext';
import {
  MCP_APP_MAX_HEIGHT,
  makeMcpAppHost,
  mcpAppAllowAttribute,
  McpAppHostRefusal,
  type McpAppConsentRequest,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext,
} from '@orkestra/core/runtimes/acp/api/client';
import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { ChatMcpAppHost, ChatMcpAppView } from '@/commands';
import { attachMcpAppDocumentLink, buildMcpAppDocument, MCP_APP_SANDBOX } from './mcp-app-document';
import type { ChatMcpApp } from './mcp-app-node';
import {
  MCP_APP_CHROME_H,
  MCP_APP_CONSENT_MIN_H,
  mcpAppConsent,
  mcpAppHeight,
  mcpAppPhase,
  setMcpAppConsent,
  setMcpAppHeight,
  setMcpAppPhase,
  type McpAppPhase,
} from './mcp-app-store';
import {
  colorSchemeOf,
  MCP_APP_THEME_SOURCES,
  mcpAppStyleVariables,
  type McpAppThemeToken,
} from './mcp-app-theme';
import * as css from './mcp-app.css';
import { vars } from '@styles/theme.css';

const fullscreenSupported =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

// Input elsewhere in Orkestra within this window does not count as a click in the app.
const PAGE_ACTIVATION_MS = 5_000;
let lastPageInputAt = Number.NEGATIVE_INFINITY;
if (typeof window !== 'undefined') {
  const note = () => {
    lastPageInputAt = performance.now();
  };
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const) {
    window.addEventListener(type, note, true);
  }
}

/** Resolves the call's app through the host; renders nothing until (and unless) it has one. */
export function McpApp(props: { data: ChatMcpApp }) {
  const commands = useCommands();
  const phase = () => mcpAppPhase(props.data.id)();

  createEffect(() => {
    const host = commands().mcpApps;
    if (!host || phase().kind !== 'idle') return;
    const id = props.data.id;
    setMcpAppPhase(id, { kind: 'loading' });
    host.resolve(props.data.call).then(
      (view) => setMcpAppPhase(id, view ? { kind: 'ready', view } : { kind: 'none' }),
      // Calls whose app cannot be resolved render as plain tool rows.
      () => setMcpAppPhase(id, { kind: 'none' })
    );
  });

  return (
    <Show when={readyView(phase())}>
      {(view) => (
        <Show when={commands().mcpApps}>
          {(host) => <McpAppCard data={props.data} view={view()} host={host()} />}
        </Show>
      )}
    </Show>
  );
}

function readyView(phase: McpAppPhase): ChatMcpAppView | undefined {
  return phase.kind === 'ready' ? phase.view : undefined;
}

function resolveTheme(probe: HTMLElement) {
  const raw: Partial<Record<McpAppThemeToken, string>> = {};
  for (const token of new Set(Object.values(MCP_APP_THEME_SOURCES))) {
    probe.style.color = vars[token];
    raw[token] = getComputedStyle(probe).color;
  }
  probe.style.color = '';
  return { scheme: colorSchemeOf(raw.bg), variables: mcpAppStyleVariables(raw) };
}

function consentText(request: McpAppConsentRequest): { question: string; detail: string } {
  if (request.kind === 'tool') {
    return {
      question: `Allow ${request.server} to run ${request.title ?? request.tool}?`,
      detail: JSON.stringify(request.arguments, null, 2),
    };
  }
  return { question: `Send this message from ${request.server}?`, detail: request.text };
}

function McpAppCard(props: { data: ChatMcpApp; view: ChatMcpAppView; host: ChatMcpAppHost }) {
  const id = props.data.id;
  const [displayMode, setDisplayMode] = createSignal<McpAppDisplayMode>('inline');
  const [closed, setClosed] = createSignal(false);
  const [navigatedAway, setNavigatedAway] = createSignal(false);
  const [generation, setGeneration] = createSignal(0);
  const live = () => props.view.live !== false;
  let cardEl: HTMLElement | undefined;
  let probeEl: HTMLSpanElement | undefined;

  // Full screen puts the card in the top layer (manual popover) without moving it in the DOM,
  // so the frame keeps its document.
  createEffect(() => {
    const card = cardEl;
    if (!card || !fullscreenSupported) return;
    if (displayMode() === 'fullscreen') {
      card.setAttribute('popover', 'manual');
      if (!card.matches(':popover-open')) card.showPopover();
    } else if (card.hasAttribute('popover')) {
      if (card.matches(':popover-open')) card.hidePopover();
      card.removeAttribute('popover');
    }
  });

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && displayMode() === 'fullscreen') setDisplayMode('inline');
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  onCleanup(() => {
    mcpAppConsent(id)()?.settle(false);
    setMcpAppConsent(id, null);
  });

  const ask = (request: McpAppConsentRequest) =>
    new Promise<boolean>((resolve) => {
      // Approvals are shown inline, above the app.
      setDisplayMode('inline');
      mcpAppConsent(id)()?.settle(false);
      setMcpAppConsent(id, {
        request,
        settle: (approved) => {
          setMcpAppConsent(id, null);
          resolve(approved);
        },
      });
    });

  const frameHeight = () =>
    mcpAppConsent(id)() ? Math.max(mcpAppHeight(id)(), MCP_APP_CONSENT_MIN_H) : mcpAppHeight(id)();

  const fullscreen = () => displayMode() === 'fullscreen';

  return (
    <div class={css.row}>
      <section
        ref={(element) => {
          cardEl = element;
        }}
        class={fullscreen() ? `${css.card} ${css.fullscreen}` : css.card}
        style={fullscreen() ? undefined : { height: `${MCP_APP_CHROME_H + frameHeight()}px` }}
        data-mcp-app-fullscreen={fullscreen() ? '' : undefined}
        aria-label={`${props.view.server} app`}
      >
        <div class={css.header}>
          <span class={css.title} title={props.view.resourceUri}>
            {props.view.server} · {props.view.tool}
          </span>
          <Show when={!live()}>
            <span class={css.badge} title="The app's MCP server is not available">
              Read-only
            </span>
          </Show>
          <Show when={fullscreen()}>
            <button type="button" class={css.headerButton} onClick={() => setDisplayMode('inline')}>
              Exit full screen
            </button>
          </Show>
        </div>
        <span
          class={css.probe}
          ref={(element) => {
            probeEl = element;
          }}
        />
        <Switch>
          <Match when={navigatedAway()}>
            <p class={css.notice}>The app left its page and was stopped.</p>
          </Match>
          <Match when={closed()}>
            <div class={css.notice}>
              <span>The app was closed.</span>
              <button
                type="button"
                class={css.button}
                onClick={() => {
                  setGeneration((value) => value + 1);
                  setClosed(false);
                }}
              >
                Show app
              </button>
            </div>
          </Match>
          <Match when={true}>
            <Show when={generation() + 1} keyed>
              {(_generation: number) => (
                <McpAppFrame
                  data={props.data}
                  view={props.view}
                  host={props.host}
                  live={live()}
                  displayMode={displayMode}
                  setDisplayMode={setDisplayMode}
                  ask={ask}
                  probe={() => probeEl}
                  onClosed={() => setClosed(true)}
                  onNavigatedAway={() => setNavigatedAway(true)}
                />
              )}
            </Show>
          </Match>
        </Switch>
        <Show when={mcpAppConsent(id)()}>
          {(consent) => {
            const text = consentText(consent().request);
            return (
              <div class={css.consent} role="dialog" aria-label={text.question}>
                <strong>{text.question}</strong>
                <pre class={css.consentDetail}>{text.detail}</pre>
                <div class={css.consentActions}>
                  <button type="button" class={css.button} onClick={() => consent().settle(false)}>
                    Deny
                  </button>
                  <button
                    type="button"
                    class={css.primaryButton}
                    onClick={() => consent().settle(true)}
                  >
                    Allow
                  </button>
                </div>
              </div>
            );
          }}
        </Show>
      </section>
    </div>
  );
}

function McpAppFrame(props: {
  data: ChatMcpApp;
  view: ChatMcpAppView;
  host: ChatMcpAppHost;
  live: boolean;
  displayMode: () => McpAppDisplayMode;
  setDisplayMode: (mode: McpAppDisplayMode) => void;
  ask: (request: McpAppConsentRequest) => Promise<boolean>;
  probe: () => HTMLElement | undefined;
  onClosed: () => void;
  onNavigatedAway: () => void;
}) {
  let frameEl: HTMLIFrameElement | undefined;
  let bridge: McpAppHost | undefined;
  const id = props.data.id;

  onMount(() => {
    const frame = frameEl;
    if (!frame) return;
    const probe = props.probe();
    let theme = probe ? resolveTheme(probe) : { scheme: 'dark' as const, variables: {} };
    let width = frame.clientWidth;

    const readOnly = () =>
      new McpAppHostRefusal('This app is read-only because its MCP server is not available.');

    const hostContext = (): McpAppHostContext => ({
      theme: theme.scheme,
      styles: { variables: theme.variables },
      displayMode: props.displayMode(),
      availableDisplayModes: fullscreenSupported ? ['inline', 'fullscreen'] : ['inline'],
      containerDimensions:
        props.displayMode() === 'fullscreen'
          ? {
              width: frame.clientWidth || window.innerWidth,
              height: frame.clientHeight || window.innerHeight,
            }
          : { width, maxHeight: MCP_APP_MAX_HEIGHT },
      platform: 'desktop',
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: `${props.host.hostName}/${props.host.hostVersion}`,
      deviceCapabilities: {
        touch: window.matchMedia('(pointer: coarse)').matches,
        hover: window.matchMedia('(hover: hover)').matches,
      },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      ...(props.view.toolDefinition === undefined
        ? {}
        : { toolInfo: { tool: props.view.toolDefinition } }),
    });

    const clickedInApp = () =>
      document.activeElement === frame && navigator.userActivation?.isActive === true;

    const link = attachMcpAppDocumentLink(
      frame,
      (data) => bridge?.receive(data),
      window.location.origin
    );
    const call = props.data.call;
    const sendMessage = props.host.sendMessage;
    bridge = makeMcpAppHost({
      app: {
        server: props.view.server,
        tool: props.view.tool,
        ...(props.view.csp ? { csp: props.view.csp } : {}),
        ...(props.view.permissions ? { permissions: props.view.permissions } : {}),
      },
      hostName: props.host.hostName,
      hostVersion: props.host.hostVersion,
      post: link.post,
      hostContext,
      toolInfo: async (name) => {
        if (!props.live) throw readOnly();
        return props.host.toolInfo(call, name);
      },
      callTool: async ({ name, arguments: args }) => {
        if (!props.live) throw readOnly();
        return props.host.callTool(call, name, args);
      },
      readResource: async ({ uri }) => {
        if (!props.live) throw readOnly();
        return props.host.readResource(call, uri);
      },
      confirm: props.ask,
      openLink: async (url) => {
        if (!clickedInApp()) {
          throw new McpAppHostRefusal('Links open only from a click in the app.');
        }
        await props.host.openLink(url);
      },
      ...(sendMessage !== undefined && props.live
        ? { sendMessage: (text: string) => sendMessage(text) }
        : {}),
      requestDisplayMode: async (mode) => {
        if (mode === 'inline') {
          props.setDisplayMode('inline');
          return 'inline';
        }
        const other = document.querySelector('[data-mcp-app-fullscreen]');
        if (
          !fullscreenSupported ||
          !clickedInApp() ||
          performance.now() - lastPageInputAt < PAGE_ACTIVATION_MS ||
          mcpAppConsent(id)() !== null ||
          (other !== null && !other.contains(frame))
        ) {
          return props.displayMode();
        }
        props.setDisplayMode(mode);
        return mode;
      },
      onRequestTeardown: () => {
        if (props.displayMode() === 'fullscreen') {
          props.setDisplayMode('inline');
          return;
        }
        void bridge?.teardown().then(() => props.onClosed());
      },
      onSizeChanged: (size) => {
        if (props.displayMode() === 'fullscreen') return;
        if (size.height !== undefined) setMcpAppHeight(id, size.height);
      },
    });

    bridge.setToolCall({
      arguments: call.input ?? props.view.input ?? {},
      result: call.result ?? props.view.result,
    });

    const onMessage = (event: MessageEvent) => link.receive(event);
    window.addEventListener('message', onMessage);

    // A second load means the app navigated away from its own document: stop it.
    let loads = 0;
    const onLoad = () => {
      loads += 1;
      if (loads > 1) {
        bridge?.dispose();
        props.onNavigatedAway();
      }
    };
    frame.addEventListener('load', onLoad);
    frame.srcdoc = buildMcpAppDocument(props.view, theme.scheme);

    let pending = 0;
    const refreshTheme = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const current = props.probe();
        if (current) theme = resolveTheme(current);
        bridge?.updateHostContext();
      });
    };
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refreshTheme);
    const resize = new ResizeObserver(() => {
      const next = frame.clientWidth;
      if (next !== width || props.displayMode() === 'fullscreen') {
        width = next;
        bridge?.updateHostContext();
      }
    });
    resize.observe(frame);

    onCleanup(() => {
      window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      themeObserver.disconnect();
      media.removeEventListener('change', refreshTheme);
      resize.disconnect();
      cancelAnimationFrame(pending);
      const current = bridge;
      bridge = undefined;
      void current?.teardown().finally(() => link.close());
    });
  });

  // The app gets the call's input and result (from the transcript, or from the snapshot).
  createEffect(() => {
    const call = props.data.call;
    const args = call.input ?? props.view.input ?? {};
    const result = call.result ?? props.view.result;
    bridge?.setToolCall({ arguments: args, result });
  });

  createEffect(() => {
    props.displayMode();
    bridge?.updateHostContext();
  });

  return (
    <iframe
      ref={(element) => {
        frameEl = element;
      }}
      class={css.frame}
      title={`${props.view.server} app`}
      sandbox={MCP_APP_SANDBOX}
      allow={mcpAppAllowAttribute(props.view.permissions)}
      referrerPolicy="no-referrer"
    />
  );
}
