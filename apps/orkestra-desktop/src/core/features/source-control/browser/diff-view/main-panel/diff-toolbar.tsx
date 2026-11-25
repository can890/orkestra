import type { GitChange, GitFilePath } from '@orkestra/core/runtimes/git/api';
import { Button, MicroLabel, ToggleGroup } from '@orkestra/ui/react/primitives';
import { AlignJustify, Columns2, Compass } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { ReviewGuideDrawer } from '@core/features/code-review/contributions/browser/review-guide-drawer';
import type { ReviewGuideSession } from '@core/features/code-review/contributions/browser/use-review-progress';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { getTaskWorkspace } from '@core/features/workbench/api/browser/task-composition-selectors';
import { commitRef } from '@core/primitives/git/api';
import { getPrNumber } from '@core/services/pull-requests/api';
import { getPullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';
import type { DiffTabResource } from '../stores/diff-tab-resource';

const NO_PR_FILES: GitChange[] = [];

interface DiffToolbarProps {
  tab: DiffTabResource;
}

export const DiffToolbar = observer(function DiffToolbar({ tab }: DiffToolbarProps) {
  const taskView = useTaskComposition();
  const { projectId, taskId } = useTaskViewContext();
  const workspace = getTaskWorkspace(projectId, taskId);
  const git = workspace?.get(gitCheckoutStoreToken);
  const diffView = taskView.diffView;
  const diffStyle = diffView?.diffStyle;
  const canPreview = tab.renderer.kind === 'text' && tab.renderer.previewKind !== undefined;
  const [guideOpen, setGuideOpen] = useState(false);

  const prStore = taskView.prStore;
  const pr =
    tab.diffGroup === 'pr' && tab.prNumber
      ? prStore?.pullRequests.find((candidate) => getPrNumber(candidate) === tab.prNumber)
      : undefined;
  const prFilesResource = guideOpen && pr && prStore ? prStore.getFiles(pr) : undefined;
  const prFiles = prFilesResource?.data;
  const reviewNumber = pr ? getPrNumber(pr) : null;
  const reviewScope =
    pr && reviewNumber && pr.baseRefOid && pr.headRefOid
      ? {
          repositoryUrl: pr.repositoryUrl,
          number: reviewNumber,
          baseRefOid: pr.baseRefOid,
          headRefOid: pr.headRefOid,
        }
      : undefined;

  const reviewSession: ReviewGuideSession | undefined =
    pr && reviewScope
      ? {
          id: pr.url,
          revision: JSON.stringify([reviewScope.baseRefOid, reviewScope.headRefOid]),
          async readFileViews(signal) {
            const client = await getPullRequestsRuntimeClient();
            const result = await client.getPullRequestFileViews(reviewScope, { signal });
            if (!result.success) throw new Error(result.error.type);
            return result.data;
          },
          async setFileViewed(account, path, viewed, diffRevision) {
            const client = await getPullRequestsRuntimeClient();
            const result = await client.setPullRequestFileViewed({
              ...reviewScope,
              account,
              path,
              viewed,
              diffRevision,
            });
            if (!result.success) throw new Error(result.error.type);
          },
        }
      : undefined;

  const reviewFiles = useMemo(() => {
    if (tab.diffGroup === 'pr') return prFiles ?? NO_PR_FILES;
    const unstaged = (git?.unstagedFileChanges ?? []).map((c) => ({
      path: c.path,
      status: c.status,
      group: 'disk' as const,
    }));
    const staged = (git?.stagedFileChanges ?? []).map((c) => ({
      path: c.path,
      status: c.status,
      group: 'staged' as const,
    }));
    const combined = [...staged, ...unstaged];
    if (combined.length === 0 && tab.path) {
      combined.push({ path: tab.path, status: tab.status ?? 'modified', group: 'disk' });
    }
    return combined;
  }, [
    git?.unstagedFileChanges,
    git?.stagedFileChanges,
    tab.path,
    tab.status,
    tab.diffGroup,
    prFiles,
  ]);

  const handleOpenReviewFile = (filePath: string) => {
    const matched = reviewFiles.find((item) => item.path === filePath);
    if (pr && reviewScope && matched) {
      taskView.activePane.open(
        'diff',
        {
          activeFile: {
            path: matched.path,
            type: 'git',
            group: 'pr',
            originalRef: commitRef(reviewScope.baseRefOid),
            modifiedRef: commitRef(reviewScope.headRefOid),
            prNumber: reviewScope.number,
            prBaseOid: reviewScope.baseRefOid,
            prHeadOid: reviewScope.headRefOid,
          },
          status: matched.status,
        },
        { preview: true }
      );
      return;
    }
    const group = matched && 'group' in matched ? matched.group : 'disk';
    taskView.activePane.open(
      'diff',
      {
        activeFile: {
          path: (matched?.path ?? filePath) as GitFilePath,
          type: 'disk',
          group,
          originalRef: commitRef('HEAD'),
        },
        status: matched?.status,
      },
      { preview: true }
    );
  };

  const diffSourceLabel = (() => {
    if (tab.diffGroup === 'staged') return 'Staged';
    if (tab.diffGroup === 'disk') return 'Changed';
    if (tab.diffGroup === 'pr') return 'PR';
    if (tab.diffGroup === 'git') return 'Git';
    return undefined;
  })();

  if (!diffView || !diffStyle) return null;

  return (
    <div className="flex h-[41px] items-center justify-between gap-2 border-b border-border bg-(--em-surface) px-2">
      <div className="flex items-center gap-3">
        {diffSourceLabel && <MicroLabel>{diffSourceLabel}</MicroLabel>}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={guideOpen ? 'primary' : 'ghost'}
          size="xs"
          onClick={() => setGuideOpen((v) => !v)}
          title="Değişen dosyalar için adım adım İnceleme Turu"
        >
          <Compass className="h-3.5 w-3.5" />
          İnceleme Turu
        </Button>
        {canPreview && (
          <ToggleGroup.Root
            multiple={false}
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'diff' || value === 'preview') tab.setViewMode(value);
            }}
          >
            <ToggleGroup.Item size="sm" value="diff" className="text-xs">
              Diff
            </ToggleGroup.Item>
            <ToggleGroup.Item size="sm" value="preview" className="text-xs">
              Preview
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        {tab.viewMode === 'diff' && (
          <ToggleGroup.Root
            multiple={false}
            value={[diffStyle]}
            onValueChange={([value]) => {
              if (value) {
                diffView.setDiffStyle(value as 'unified' | 'split');
              }
            }}
          >
            <ToggleGroup.Item size="sm" icon value="unified" aria-label="Unified diff">
              <AlignJustify className="h-3.5 w-3.5" />
            </ToggleGroup.Item>
            <ToggleGroup.Item size="sm" icon value="split" aria-label="Split diff">
              <Columns2 className="h-3.5 w-3.5" />
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
      </div>
      <ReviewGuideDrawer
        key={pr?.url ?? 'local'}
        reviewSession={reviewSession}
        filesLoading={prFilesResource?.loading}
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        files={reviewFiles}
        activeFilePath={tab.path}
        onSelectFile={handleOpenReviewFile}
      />
    </div>
  );
});
