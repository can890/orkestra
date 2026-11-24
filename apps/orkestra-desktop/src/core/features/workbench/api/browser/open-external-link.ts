import { toast } from '@orkestra/ui/react/primitives';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import {
  asProvisioned,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getFocusedTaskSurface } from '@core/features/workbench/api/browser/focused-task-surface';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal } from '@core/manifests/browser/modal-api';
import {
  copyTextToClipboard,
  openExternal,
} from '@core/primitives/desktop-host/browser/host-client';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { normalizeExternalHttpUrl } from './external-url';

const HTTP_URL_PATTERN = /^https?:\/\//i;

export function confirmOpenExternalLink(url: string, onError?: (error: unknown) => void): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);

  if (!HTTP_URL_PATTERN.test(normalizedUrl)) {
    return;
  }

  const taskView = getActiveTaskView();

  void openModal('confirmExternalLinkModal', {
    url: normalizedUrl,
    canOpenInOrkestraBrowser: taskView !== undefined,
    onCopy: () => copyExternalLink(normalizedUrl),
  }).then((outcome) => {
    if (!outcome.success) return;
    if (outcome.data === 'orkestra-browser' && taskView) {
      const workspaceId =
        asProvisioned(getTaskStore(taskView.projectId, taskView.taskId))?.workspaceId ??
        taskView.taskId;
      browserRightPanelStore.openTab(
        { projectId: taskView.projectId, workspaceId, taskId: taskView.taskId },
        { initialUrl: normalizedUrl, mode: 'panel', activate: true }
      );
      return;
    }
    void openExternal(normalizedUrl).catch((error) => {
      onError?.(error);
    });
  });
}

async function copyExternalLink(url: string): Promise<boolean> {
  try {
    const result = await copyTextToClipboard(url);
    if (!result.success) {
      showCopyFailure();
      return false;
    }
    toast('Link copied');
    return true;
  } catch {
    showCopyFailure();
    return false;
  }
}

function showCopyFailure(): void {
  toast.error('Copy failed', { description: 'The link could not be copied to the clipboard.' });
}

function getActiveTaskView() {
  const ref = getNavigation().currentRef;
  if (ref.viewId !== 'task') {
    // Outside the task view (for example the board) the focused surface owns the task.
    const surface = getFocusedTaskSurface();
    return surface ? getTaskComposition(surface.projectId, surface.taskId) : undefined;
  }
  const { projectId, taskId } = ref.params as {
    projectId?: string;
    taskId?: string;
  };
  if (!projectId || !taskId) return undefined;
  return getTaskComposition(projectId, taskId);
}
