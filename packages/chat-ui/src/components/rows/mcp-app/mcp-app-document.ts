// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/shared/src/mcpApp.ts,
// apps/web/src/components/chat/mcpAppDocumentLink.ts
import { injectAfterMcpAppCsp, injectMcpAppCsp } from '@orkestra/core/runtimes/acp/api/client';
import type { ChatMcpAppView } from '@/commands';

/**
 * The document an MCP app runs in. The app's HTML is untrusted code: the iframe is sandboxed
 * without `allow-same-origin` (opaque origin: no access to Orkestra's origin, storage, preload or
 * Wire) and the document starts with a CSP `<meta>` derived from the resource's declared CSP
 * metadata, so the network is limited to the declared domains. Our bootstrap scripts come right
 * after the CSP and before any app code.
 */

/** `sandbox` attribute of the app frame. Never add `allow-same-origin`, popups or navigation. */
export const MCP_APP_SANDBOX = 'allow-scripts allow-forms';

/** Marker of the bootstrap's first message, which hands the host a private port. */
export const MCP_APP_DOCUMENT_MESSAGE = 'orkestra-mcp-app-document';

/**
 * Binds the host bridge to this document rather than to the frame's window, which outlives it:
 * the first script hands the host a private port; the host answers only over that port and acts
 * on a message only once this document confirms (over the port) that it is still alive. A page
 * the app navigates to cannot impersonate it.
 */
export function documentBootstrapScript(): string {
  return `<script>(function(){var host=window.parent,port=new MessageChannel(),own=port.port1;own.onmessage=function(event){var data=event.data;if(!data)return;if("alive" in data)own.postMessage({alive:data.alive});else window.dispatchEvent(new MessageEvent("message",{data:data.message,origin:data.origin,source:host}));};host.postMessage({orkestra:${JSON.stringify(MCP_APP_DOCUMENT_MESSAGE)}},"*",[port.port2]);})();</script>`;
}

/** Sets the initial colour scheme before the app paints, then follows `ui/initialize` updates. */
export function themeBootstrapScript(scheme: 'light' | 'dark'): string {
  return `<script>(function(){try{var meta=document.createElement("meta");meta.name="color-scheme";meta.content=${JSON.stringify(scheme)};document.head.append(meta);}catch(e){}window.addEventListener("message",function(event){if(event.source!==window.parent)return;var m=event.data;if(!m||m.jsonrpc!=="2.0")return;var theme=m.method==="ui/notifications/host-context-changed"?m.params&&m.params.theme:m.id!==undefined&&m.method===undefined?m.result&&m.result.hostContext&&m.result.hostContext.theme:undefined;if(theme==="light"||theme==="dark")document.documentElement.style.colorScheme=theme;});})();</script>`;
}

/** Opaque documents throw on cookie reads; analytics code often expects an empty string. */
const COOKIE_BOOTSTRAP = `<script>(function(){try{void document.cookie;}catch(error){if(error&&error.name==="SecurityError"){Object.defineProperty(document,"cookie",{configurable:true,get:function(){return "";},set:function(){}});}}})();</script>`;

/** Full `srcdoc`: CSP first, then our bootstraps (document link first), then the app. */
export function buildMcpAppDocument(view: ChatMcpAppView, scheme: 'light' | 'dark'): string {
  let html = injectMcpAppCsp(view.html, view.csp);
  html = injectAfterMcpAppCsp(html, COOKIE_BOOTSTRAP);
  html = injectAfterMcpAppCsp(html, themeBootstrapScript(scheme));
  html = injectAfterMcpAppCsp(html, documentBootstrapScript());
  return html;
}

const MAX_UNCONFIRMED_MESSAGES = 256;

type LinkFrame = { readonly contentWindow: unknown };
type LinkEvent = {
  readonly source: unknown;
  readonly data: unknown;
  readonly ports?: readonly MessagePort[];
};

/**
 * Host side of the document link. `receive` takes window `message` events, accepts only those
 * from the frame's window and delivers an app message only after the first document confirms it
 * over its private port. Documents without the bootstrap never reach the host.
 */
export function attachMcpAppDocumentLink(
  frame: LinkFrame,
  deliver: (data: unknown) => void,
  hostOrigin: string
) {
  let port: MessagePort | null = null;
  let nextProbe = 0;
  const unconfirmed = new Map<number, unknown>();
  return {
    receive: (event: LinkEvent) => {
      if (event.source === null || event.source !== frame.contentWindow) return;
      if (port === null) {
        const data = event.data as { orkestra?: unknown } | null | undefined;
        const offered = data?.orkestra === MCP_APP_DOCUMENT_MESSAGE ? event.ports?.[0] : undefined;
        if (!offered) return;
        port = offered;
        port.onmessage = (reply: MessageEvent) => {
          const probe: unknown = (reply.data as { alive?: unknown } | null)?.alive;
          if (typeof probe !== 'number' || !unconfirmed.has(probe)) return;
          const message = unconfirmed.get(probe);
          unconfirmed.delete(probe);
          deliver(message);
        };
        return;
      }
      if (unconfirmed.size >= MAX_UNCONFIRMED_MESSAGES) return;
      unconfirmed.set(nextProbe, event.data);
      port.postMessage({ alive: nextProbe });
      nextProbe += 1;
    },
    post: (message: unknown) => {
      port?.postMessage({ message, origin: hostOrigin });
    },
    close: () => {
      port?.close();
      port = null;
      unconfirmed.clear();
    },
  };
}
