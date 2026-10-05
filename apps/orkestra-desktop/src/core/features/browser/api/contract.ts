import { defineContract, eventStream, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import type {
  BrowserAgentRequestReply,
  BrowserDataClearKind,
  BrowserEvent,
  BrowsingDataKind,
} from '@core/primitives/browser/api';

type BrowserActionResult = { success: boolean; error?: string };

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
  events: eventStream({ key: z.void(), event: z.custom<BrowserEvent>() }),
});
