import { describe, expect, it, vi } from 'vitest';
import {
  MCP_APP_DOCUMENT_MESSAGE,
  MCP_APP_SANDBOX,
  attachMcpAppDocumentLink,
  buildMcpAppDocument,
} from './mcp-app-document';

const view = {
  server: 'weather',
  tool: 'forecast',
  resourceUri: 'ui://weather/app',
  html: '<!doctype html><html><head><script>window.app = 1</script></head><body>x</body></html>',
  csp: { connectDomains: ['https://api.weather.test'] },
};

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('buildMcpAppDocument', () => {
  it('puts the CSP first and our bootstraps before any app script', () => {
    const doc = buildMcpAppDocument(view, 'dark');
    const csp = doc.indexOf('<meta http-equiv="Content-Security-Policy"');
    const link = doc.indexOf(MCP_APP_DOCUMENT_MESSAGE);
    const theme = doc.indexOf('"color-scheme"');
    const app = doc.indexOf('window.app = 1');
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(csp).toBeLessThan(link);
    expect(link).toBeLessThan(theme);
    expect(theme).toBeLessThan(app);
    expect(doc).toContain('connect-src https://api.weather.test');
  });

  it('keeps the frame on an opaque origin', () => {
    expect(MCP_APP_SANDBOX).not.toContain('allow-same-origin');
    expect(MCP_APP_SANDBOX).not.toContain('allow-top-navigation');
    expect(MCP_APP_SANDBOX).not.toContain('allow-popups');
  });
});

/** Simulates the document bootstrap: it answers liveness probes on its private port. */
function documentSide() {
  const channel = new MessageChannel();
  const received: unknown[] = [];
  channel.port1.onmessage = (event: MessageEvent) => {
    const data = event.data as { alive?: number; message?: unknown };
    if ('alive' in data) channel.port1.postMessage({ alive: data.alive });
    else received.push(data.message);
  };
  return { channel, received };
}

describe('attachMcpAppDocumentLink', () => {
  it('delivers app messages only after the first document confirms them', async () => {
    const frameWindow = {};
    const frame = { contentWindow: frameWindow };
    const deliver = vi.fn();
    const link = attachMcpAppDocumentLink(frame, deliver, 'app://orkestra');
    const doc = documentSide();

    // Nothing is delivered before the document hands over its port.
    link.receive({ source: frameWindow, data: { jsonrpc: '2.0', method: 'early' } });
    link.receive({
      source: frameWindow,
      data: { orkestra: MCP_APP_DOCUMENT_MESSAGE },
      ports: [doc.channel.port2],
    });
    link.receive({ source: frameWindow, data: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    // Other windows are ignored.
    link.receive({ source: {}, data: { jsonrpc: '2.0', id: 2, method: 'ping' } });
    await wait();
    expect(deliver.mock.calls).toEqual([[{ jsonrpc: '2.0', id: 1, method: 'ping' }]]);

    link.post({ jsonrpc: '2.0', id: 1, result: {} });
    await wait();
    expect(doc.received).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    doc.channel.port1.close();
    link.close();
  });

  it('drops messages once the first document is gone (navigation)', async () => {
    const frameWindow = {};
    const deliver = vi.fn();
    const link = attachMcpAppDocumentLink({ contentWindow: frameWindow }, deliver, 'x');
    const doc = documentSide();
    link.receive({
      source: frameWindow,
      data: { orkestra: MCP_APP_DOCUMENT_MESSAGE },
      ports: [doc.channel.port2],
    });
    // The original document goes away; a new page in the same frame window posts a request.
    doc.channel.port1.onmessage = null;
    doc.channel.port1.close();
    link.receive({ source: frameWindow, data: { jsonrpc: '2.0', id: 7, method: 'tools/call' } });
    await wait();
    expect(deliver).not.toHaveBeenCalled();
    link.close();
  });

  it('ignores a handshake without the marker or a port', async () => {
    const frameWindow = {};
    const deliver = vi.fn();
    const link = attachMcpAppDocumentLink({ contentWindow: frameWindow }, deliver, 'x');
    link.receive({ source: frameWindow, data: { orkestra: 'something-else' } });
    link.receive({ source: frameWindow, data: { orkestra: MCP_APP_DOCUMENT_MESSAGE } });
    link.receive({ source: frameWindow, data: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    await wait();
    expect(deliver).not.toHaveBeenCalled();
  });
});
