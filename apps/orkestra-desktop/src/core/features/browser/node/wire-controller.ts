import { createController, type Controller } from '@orkestra/wire/rpc';
import type {
  BrowserAgentRequestReply,
  BrowserDataClearKind,
  BrowserTaskActiveTabs,
  BrowsingDataKind,
} from '@core/primitives/browser/api';
import { browserContract, type BrowserRecordingResult } from '../api';
import { browserEvents } from './event-host';

export type BrowserSessionRegistration = {
  browserId: string;
  partition: string;
  /** Task identity of the tab; optional for callers that predate agent tab tracking. */
  projectId?: string;
  workspaceId?: string;
  taskId?: string;
  /** Last known page state, reported to agents until the webview is bound. */
  url?: string;
  title?: string;
};

export type BrowserOperations = {
  registerSession(input: BrowserSessionRegistration): BrowserActionResult;
  unregisterSession(browserId: string): BrowserActionResult;
  syncSessions(browserIds: string[]): BrowserActionResult;
  bindWebContents(input: { browserId: string; webContentsId: number }): BrowserActionResult;
  setActiveBrowser(browserId: string | null): BrowserActionResult;
  getActiveBrowser(): { browserId: string | null };
  syncTaskActiveBrowsers(tasks: BrowserTaskActiveTabs[]): BrowserActionResult;
  resolveAgentRequest(reply: BrowserAgentRequestReply): BrowserActionResult;
  openDevTools(browserId: string): BrowserActionResult;
  captureScreenshot(browserId: string): Promise<BrowserActionResult>;
  clearData(browserId: string, kind: BrowserDataClearKind): Promise<BrowserActionResult>;
  clearProfileStorage(profileId: string): Promise<BrowserActionResult>;
  clearBrowsingData(kind: BrowsingDataKind): Promise<BrowserActionResult>;
  recording(
    browserId: string,
    action: 'status' | 'start' | 'stop' | 'steps'
  ): Promise<BrowserRecordingResult>;
};

type BrowserActionResult = { success: boolean; error?: string };

export function createBrowserWireController(browserOperations: BrowserOperations): Controller {
  return createController(browserContract, {
    registerSession: (input) => browserOperations.registerSession(input),
    unregisterSession: ({ browserId }) => browserOperations.unregisterSession(browserId),
    syncSessions: ({ browserIds }) => browserOperations.syncSessions(browserIds),
    bindWebContents: (input) => browserOperations.bindWebContents(input),
    setActiveBrowser: ({ browserId }) => browserOperations.setActiveBrowser(browserId),
    getActiveBrowser: () => browserOperations.getActiveBrowser(),
    syncTaskActiveBrowsers: ({ tasks }) => browserOperations.syncTaskActiveBrowsers(tasks),
    resolveAgentRequest: (reply) => browserOperations.resolveAgentRequest(reply),
    openDevTools: ({ browserId }) => browserOperations.openDevTools(browserId),
    captureScreenshot: ({ browserId }) => browserOperations.captureScreenshot(browserId),
    clearData: ({ browserId, kind }) => browserOperations.clearData(browserId, kind),
    clearProfileStorage: ({ profileId }) => browserOperations.clearProfileStorage(profileId),
    clearBrowsingData: ({ kind }) => browserOperations.clearBrowsingData(kind),
    recording: ({ browserId, action }) => browserOperations.recording(browserId, action),
    events: browserEvents,
  });
}
