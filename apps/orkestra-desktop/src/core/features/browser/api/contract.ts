import { defineContract, eventStream, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import type {
  BrowserAgentRequestReply,
  BrowserColorScheme,
  BrowserDataClearKind,
  BrowserEvent,
  BrowsingDataKind,
} from '@core/primitives/browser/api';
import type {
  BrowserRecordedStep,
  BrowserRecordingStatus,
} from '@core/primitives/browser/api/agent-browser';
import {
  browserImportInputSchema,
  type BrowserImportResult,
  type BrowserImportSource,
} from './browser-import';

type BrowserActionResult = { success: boolean; error?: string };

/** Araç çubuğundaki kayıt menüsünün sonucu. */
export type BrowserRecordingResult = {
  success: boolean;
  error?: string;
  status?: BrowserRecordingStatus;
  steps?: BrowserRecordedStep[];
};

export const browserPickedElementSchema = z.object({
  selector: z.string(),
  tagName: z.string(),
  id: z.string(),
  classes: z.array(z.string()),
  textSnippet: z.string(),
  outerHtmlSnippet: z.string(),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  computedStyles: z.record(z.string(), z.string()),
  pageUrl: z.string(),
  pageTitle: z.string(),
  screenshotBase64: z.string().optional(),
});

export type BrowserPickedElement = z.infer<typeof browserPickedElementSchema>;

export const browserPickElementResultSchema = z.object({
  success: z.boolean(),
  cancelled: z.boolean().optional(),
  element: browserPickedElementSchema.optional(),
  error: z.string().optional(),
});

export type BrowserPickElementResult = z.infer<typeof browserPickElementResultSchema>;

export const browserDomain = 'browser' as const;

export const browserContract = defineContract({
  registerSession: procedure({
    input: z.object({
      browserId: z.string(),
      partition: z.string(),
      // Task identity of the tab; lets main answer agent tab queries per task.
      projectId: z.string().optional(),
      workspaceId: z.string().optional(),
      taskId: z.string().optional(),
      // Last known page state, shown to agents until the webview is bound.
      url: z.string().optional(),
      title: z.string().optional(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  unregisterSession: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  /**
   * Drops every registered session the renderer no longer owns. A freshly loaded renderer
   * calls it once before registering sessions so a window reload cannot leak stale tabs.
   */
  syncSessions: procedure({
    input: z.object({ browserIds: z.array(z.string()) }),
    output: z.custom<BrowserActionResult>(),
  }),
  bindWebContents: procedure({
    input: z.object({ browserId: z.string(), webContentsId: z.number() }),
    output: z.custom<BrowserActionResult>(),
  }),
  setActiveBrowser: procedure({
    input: z.object({ browserId: z.string().nullable() }),
    output: z.custom<BrowserActionResult>(),
  }),
  getActiveBrowser: procedure({
    input: z.void(),
    output: z.object({ browserId: z.string().nullable() }),
  }),
  /** Full snapshot of the front browser tab(s) of every task's panes. */
  syncTaskActiveBrowsers: procedure({
    input: z.object({
      tasks: z.array(
        z.object({
          projectId: z.string(),
          taskId: z.string(),
          browserIds: z.array(z.string()),
        })
      ),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** Renderer answer to an `open-requested`, `activate-requested` or `close-requested` event. */
  resolveAgentRequest: procedure({
    input: z.custom<BrowserAgentRequestReply>(),
    output: z.custom<BrowserActionResult>(),
  }),
  openDevTools: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  captureScreenshot: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  pickElement: procedure({
    input: z.object({ browserId: z.string() }),
    output: browserPickElementResultSchema,
  }),
  cancelPickElement: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  openPipWindow: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  closePipWindow: procedure({
    input: z.object({ browserId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  findInPage: procedure({
    input: z.object({
      browserId: z.string(),
      text: z.string(),
      forward: z.boolean().optional(),
      matchCase: z.boolean().optional(),
      findNext: z.boolean().optional(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  stopFindInPage: procedure({
    input: z.object({
      browserId: z.string(),
      action: z.enum(['clearSelection', 'keepSelection', 'activateSelection']).optional(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  setColorScheme: procedure({
    input: z.object({
      browserId: z.string(),
      colorScheme: z.custom<BrowserColorScheme>(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  setAudioMuted: procedure({
    input: z.object({
      browserId: z.string(),
      muted: z.boolean(),
    }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearData: procedure({
    input: z.object({ browserId: z.string(), kind: z.custom<BrowserDataClearKind>() }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearProfileStorage: procedure({
    input: z.object({ profileId: z.string() }),
    output: z.custom<BrowserActionResult>(),
  }),
  clearBrowsingData: procedure({
    input: z.object({ kind: z.custom<BrowsingDataKind>() }),
    output: z.custom<BrowserActionResult>(),
  }),
  /** Çerez aktarılabilecek kurulu tarayıcılar ve profilleri (yalnızca bu platformda desteklenenler). */
  listImportSources: procedure({
    input: z.void(),
    output: z.custom<BrowserImportSource[]>(),
  }),
  /** Seçilen tarayıcı profilinin çerezlerini bir Orkestra profiline tek seferlik kopyalar. */
  importCookies: procedure({
    input: browserImportInputSchema,
    output: z.custom<BrowserImportResult>(),
  }),
  /** macOS: Safari çerezleri için Tam Disk Erişimi verilmiş mi? */
  checkFullDiskAccess: procedure({
    input: z.void(),
    output: z.object({ granted: z.boolean() }),
  }),
  openFullDiskAccessSettings: procedure({
    input: z.void(),
    output: z.custom<BrowserActionResult>(),
  }),
  /**
   * Sekmedeki eylem kaydını yönetir: durum, başlat (kullanıcının eylemleri dahil), durdur ya da
   * süren/son kaydın adımları.
   */
  recording: procedure({
    input: z.object({
      browserId: z.string(),
      action: z.enum(['status', 'start', 'stop', 'steps']),
    }),
    output: z.custom<BrowserRecordingResult>(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<BrowserEvent>() }),
});
