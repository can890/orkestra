/**
 * offscreen-preview — Zero-download Electron offscreen BrowserWindow previewer
 * for `preview_widget` (returns PNG screenshot, contentHeight, and console logs).
 * All external network requests are blocked inside a dedicated ephemeral partition.
 *
 * Adapted from T3 Code (MIT License) HtmlRender.ts.
 */

import { BrowserWindow, session } from 'electron';
import { inlineLocalImagesInHtml } from './local-image-inliner';

export type WidgetPreviewResult = {
  pngBase64: string;
  contentHeight: number;
  width: number;
  consoleMessages: string[];
  inlinedImages: number;
};

export async function renderWidgetPreviewOffscreen(input: {
  html?: string;
  svg?: string;
  width?: number;
  appearance?: 'dark' | 'light';
}): Promise<WidgetPreviewResult> {
  const width = Math.max(240, Math.min(1400, Math.round(input.width ?? 728)));
  const appearance = input.appearance ?? 'dark';
  const rawBody = input.svg ? input.svg : (input.html ?? '');
  const { html: inlinedBody, inlinedCount } = await inlineLocalImagesInHtml(rawBody);

  const bg = appearance === 'dark' ? '#18181b' : '#ffffff';
  const fg = appearance === 'dark' ? '#f4f4f5' : '#18181b';
  const muted = appearance === 'dark' ? '#a1a1aa' : '#52525b';
  const border = appearance === 'dark' ? '#27272a' : '#e4e4e7';
  const accent = appearance === 'dark' ? '#60a5fa' : '#2563eb';

  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--widget-bg:${bg};--widget-fg:${fg};--widget-muted:${muted};--widget-border:${border};--widget-accent:${accent};color-scheme:${appearance};}
html,body{margin:0;padding:12px;background:${bg};color:${fg};font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;box-sizing:border-box;}
*,*::before,*::after{box-sizing:border-box;}
</style></head><body>${inlinedBody}</body></html>`;

  const partition = `widget-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith('data:') ||
      details.url.startsWith('about:') ||
      details.url.startsWith('blob:');
    callback({ cancel: !allowed });
  });

  const win = new BrowserWindow({
    show: false,
    width,
    height: 600,
    backgroundColor: bg,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: ses,
    },
  });

  const consoleMessages: string[] = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (consoleMessages.length < 30) {
      const prefix = level >= 2 ? '[error]' : level === 1 ? '[warn]' : '[log]';
      consoleMessages.push(`${prefix} ${message}`);
    }
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`;
    await win.loadURL(dataUrl);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const measured: number = await win.webContents
      .executeJavaScript(
        'Math.max(80, Math.min(2000, Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))))',
        true
      )
      .catch(() => 400);

    win.setContentSize(width, measured);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const image = await win.webContents.capturePage();
    return {
      pngBase64: image.toPNG().toString('base64'),
      contentHeight: measured,
      width,
      consoleMessages,
      inlinedImages: inlinedCount,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
