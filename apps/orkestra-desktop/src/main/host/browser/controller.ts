import { webContents } from 'electron';
import type { BrowserRecordingResult } from '@core/features/browser/api';
import type { BrowserSessionRegistration } from '@core/features/browser/node/wire-controller';
import {
  BROWSER_AGENT_PROFILE_PARTITION,
  browserProfilePartition,
  DEFAULT_BROWSER_PROFILE_ID,
  isBrowserDataClearKind,
  isBrowsingDataKind,
  type BrowserAgentRequestReply,
  type BrowserDataClearKind,
  type BrowserTaskActiveTabs,
} from '@core/primitives/browser/api';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import { agentBrowserPort } from '@main/host/browser/agent-browser-port';
import { configureBrowserProfileSession } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { isBrowserPartition } from '@main/host/browser/webview-security';

export const browserOperations = {
  registerSession: (args: BrowserSessionRegistration) => {
    if (!args.browserId.trim() || !isBrowserPartition(args.partition)) {
      return { success: false as const, error: 'Invalid browser session' };
    }
    configureBrowserProfileSession(args.partition);
    browserWebContentsRegistry.registerSession(args);
    return { success: true as const };
  },

  unregisterSession: (browserId: string) => {
    browserWebContentsRegistry.unregisterSession(browserId);
    return { success: true as const };
  },

  syncSessions: (browserIds: string[]) => {
    browserWebContentsRegistry.syncSessions(browserIds);
    return { success: true as const };
  },

  bindWebContents: (args: { browserId: string; webContentsId: number }) => {
    const target = webContents.fromId(args.webContentsId);
    if (!target || target.isDestroyed()) {
      return { success: false as const };
    }
    return { success: browserWebContentsRegistry.bindWebContents(args.browserId, target) };
  },

  setActiveBrowser: (browserId: string | null) => {
    browserWebContentsRegistry.setActiveBrowser(browserId);
    return { success: true as const };
  },

  getActiveBrowser: () => ({ browserId: browserWebContentsRegistry.getActiveBrowser() }),

  syncTaskActiveBrowsers: (tasks: BrowserTaskActiveTabs[]) => {
    browserWebContentsRegistry.syncTaskActiveBrowsers(tasks);
    return { success: true as const };
  },

  resolveAgentRequest: (reply: BrowserAgentRequestReply) => ({
    success: browserWebContentsRegistry.resolveAgentRequest(reply),
  }),

  openDevTools: (browserId: string) => ({
    success: import.meta.env.DEV && browserWebContentsRegistry.openDevTools(browserId),
  }),

  captureScreenshot: async (browserId: string) => ({
    success: await browserWebContentsRegistry.captureScreenshotToClipboard(browserId),
  }),

  clearData: async (browserId: string, kind: BrowserDataClearKind) => {
    if (!isBrowserDataClearKind(kind)) {
      return { success: false as const, error: 'Invalid browser data clear kind' };
    }
    return { success: await browserWebContentsRegistry.clearData(browserId, kind) };
  },

  clearProfileStorage: async (profileId: string) => ({
    success: await browserWebContentsRegistry.clearProfileStorage(profileId),
  }),

  recording: async (
    browserId: string,
    action: 'status' | 'start' | 'stop' | 'steps'
  ): Promise<BrowserRecordingResult> => {
    // Durum sorgusu sayfa kontrolcüsü oluşturmaz; kayıt yoksa boş durum döner.
    const page = agentBrowserPort.userPage(browserId, { create: action === 'start' });
    if (!page) {
      return action === 'status' || action === 'steps'
        ? {
            success: true,
            status: { recording: false, includesUser: false, stepCount: 0 },
            steps: [],
          }
        : { success: false, error: 'The browser tab is not loaded.' };
    }
    try {
      if (action === 'start') await page.startRecording?.({ includeUser: true });
      const steps =
        action === 'stop'
          ? await page.stopRecording?.()
          : action === 'steps'
            ? page.recordedSteps?.()
            : undefined;
      const status = page.recordingStatus?.();
      return { success: true, ...(status ? { status } : {}), ...(steps ? { steps } : {}) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  clearBrowsingData: async (kind: string) => {
    if (!isBrowsingDataKind(kind)) {
      return { success: false as const, error: 'Invalid browsing data kind' };
    }
    const partitions = await collectBrowserPartitions();
    return { success: await browserWebContentsRegistry.clearBrowsingData(kind, partitions) };
  },
};

// Every persistent profile partition (default + named + agent) plus any partitions with
// live sessions, so clearing browsing data covers isolated-per-task tabs too.
async function collectBrowserPartitions(): Promise<string[]> {
  const browserSettings = await getAppSettingsService().get('browser');
  const partitions = new Set<string>([
    browserProfilePartition(DEFAULT_BROWSER_PROFILE_ID),
    BROWSER_AGENT_PROFILE_PARTITION,
  ]);
  for (const profile of browserSettings.profiles) {
    partitions.add(browserProfilePartition(profile.id));
  }
  for (const partition of browserWebContentsRegistry.registeredPartitions) {
    partitions.add(partition);
  }
  return [...partitions];
}
