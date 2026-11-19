/**
 * Widget stories — `show_widget` tool calls drawn inline as sandboxed iframes.
 *
 * The widget is the call's own input kept on the transcript node, so these stories seed ordinary
 * tool nodes. Scripts run inside the sandbox (`allow-scripts` only, strict CSP: no network).
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import type { ToolNode, ToolStatus } from '@/model';
import { ChatHost } from '@/stories/_harness/chat-host';

const meta: Meta = {
  title: 'Rows/Tools/Widget',
  component: ChatHost,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ChatHost>;

function widgetNode(
  id: string,
  widget: { title: string; html?: string; svg?: string },
  status: ToolStatus = 'done'
): ToolNode {
  return {
    kind: 'unknown-tool-call',
    id,
    seq: 0,
    toolCallId: id,
    title: 'mcp__orkestra-widgets__show_widget',
    name: 'mcp__orkestra-widgets__show_widget',
    toolKind: 'other',
    status,
    widget,
  };
}

const COUNTER_HTML = `
<h3 style="margin:0 0 8px">Sayaç</h3>
<p>Değer: <b id="n" style="color:var(--widget-accent)">0</b></p>
<button id="inc" style="padding:6px 12px;border:1px solid var(--widget-border);border-radius:6px;background:transparent;color:var(--widget-fg);cursor:pointer">Artır</button>
<script>
  var n = 0;
  document.getElementById('inc').addEventListener('click', function () {
    n += 1;
    document.getElementById('n').textContent = String(n);
  });
</script>`;

const CHART_SVG = `
<svg viewBox="0 0 240 120" role="img" aria-label="Çubuk grafik">
  <g fill="none" stroke="currentColor" stroke-opacity="0.3"><path d="M20 100h200M20 20v80"/></g>
  <rect x="40" y="60" width="28" height="40" rx="3" fill="#6cb0ff"/>
  <rect x="90" y="30" width="28" height="70" rx="3" fill="#6cb0ff"/>
  <rect x="140" y="48" width="28" height="52" rx="3" fill="#6cb0ff"/>
  <rect x="190" y="20" width="28" height="80" rx="3" fill="#6cb0ff"/>
</svg>`;

/** Interactive HTML with a script; it only changes its own DOM. */
export const InteractiveHtml: Story = {
  render: () => (
    <ChatHost items={[widgetNode('w-html', { title: 'Sayaç', html: COUNTER_HTML })]} height={360} />
  ),
};

/** SVG input is drawn inside the iframe, never in the app DOM. */
export const Svg: Story = {
  render: () => (
    <ChatHost
      items={[widgetNode('w-svg', { title: 'Çubuk grafik', svg: CHART_SVG })]}
      height={360}
    />
  ),
};

/** The widget asks for a taller document; the row follows, up to the 800 px limit. */
export const TallContent: Story = {
  render: () => (
    <ChatHost
      items={[
        widgetNode('w-tall', {
          title: 'Uzun içerik',
          html: '<div style="height:520px;background:linear-gradient(var(--widget-accent),transparent)">520 px</div>',
        }),
      ]}
      height={640}
    />
  ),
};

/** Attempts to reach the network or the app are blocked by the CSP and the sandbox. */
export const BlockedNetwork: Story = {
  render: () => (
    <ChatHost
      items={[
        widgetNode('w-net', {
          title: 'Ağ erişimi denemesi',
          html: `<p id="out">deneniyor…</p>
<script>
  fetch('https://example.com/').then(
    function () { document.getElementById('out').textContent = 'AĞ ERİŞİMİ AÇIK (olmamalı)'; },
    function () { document.getElementById('out').textContent = 'Ağ erişimi engellendi.'; }
  );
</script>`,
        }),
      ]}
      height={260}
    />
  ),
};

/** A failed call is a plain tool row, not a widget. */
export const FailedCall: Story = {
  render: () => (
    <ChatHost
      items={[widgetNode('w-err', { title: 'Hata', html: '<p>x</p>' }, 'error')]}
      height={120}
    />
  ),
};
