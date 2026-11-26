import { DropdownMenu, Tooltip } from '@orkestra/ui/react/primitives';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  Folder,
  GitBranch,
  GitMerge,
  Globe,
  Laptop,
  Play,
  Plus,
  RefreshCcw,
  Server,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { browserRightPanelStore } from '@core/features/browser/api/browser/browser-right-panel-store';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { isSupersededConversation } from '@core/features/conversations/api/browser/handoff-visibility';
import { ConversationAgentIcon } from '@core/features/conversations/browser/conversation-agent-icon';
import { conversationTabKind } from '@core/features/conversations/browser/conversation-tab-kind';
import { conversationTabTitle } from '@core/features/conversations/browser/conversation-tab-title';
import {
  asAvailableProject,
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { OpenInMenu } from '@core/features/settings/contributions/browser/open-in-menu';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { useGitActions } from '@core/features/source-control/api/browser/use-git-actions';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import {
  getRegisteredTaskData,
  getTaskStore,
  taskDisplayName,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useConversations,
  usePreviewServers,
  useTaskComposition,
  useWorkspace,
} from '@core/features/workbench/api/browser/task-composition-context';
import { useTabSelection } from '@core/features/workbench/api/browser/task-tab-registry';
import { lifecycleScriptsStoreToken } from '@core/features/workspaces/contributions/browser/workspace-stores';
import {
  copyTextToClipboard,
  getHostClient,
  openExternal,
} from '@core/primitives/desktop-host/browser/host-client';
import { formatDiffLineCount } from '@core/primitives/formatting/browser/format-diff-line-count';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { isFreeChatProjectId } from '@core/primitives/projects/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { LocalMergeDialog } from '../components/local-merge-dialog';
import { formatPreviewServerLabel } from '../components/preview-servers/preview-server-format';

/**
 * T3 Code tarzı sağ Görev Ayrıntıları kartı (Ortam, Editörle Aç, Proje Scriptleri,
 * Git & Değişiklikler, Çalışan Sunucular ve Soy Ağacı / Önceki Ajanlar).
 */
export const TaskDetailsPanel = observer(function TaskDetailsPanel() {
  const { projectId, taskId } = useTaskViewContext();
  const taskStore = getTaskStore(projectId, taskId);
  const taskPayload = getRegisteredTaskData(projectId, taskId);
  const workspace = useWorkspace();
  const taskView = useTaskComposition();
  const conversations = useConversations();
  const previews = usePreviewServers();
  const gitCheckout = workspace.get(gitCheckoutStoreToken);
  const lifecycleScriptsMgr = workspace.get(lifecycleScriptsStoreToken);
  const { navigate } = useNavigate();

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [showLineageList, setShowLineageList] = useState(false);

  const isFreeChat = isFreeChatProjectId(projectId);
  const projectContext = asAvailableProject(getProjectStore(projectId));
  const isRemoteProject = projectContext?.project.type === 'ssh';
  const projectName = projectDisplayName(getProjectStore(projectId));

  const {
    isPublished,
    aheadCount,
    behindCount,
    fetch,
    pull,
    push,
    publish,
    isPublishing,
    isFetching,
    isPulling,
    isPushing,
  } = useGitActions(projectId, taskId);

  if (!taskStore || !taskPayload) return null;

  const workspacePath = workspace.path;
  const currentBranchName = gitCheckout.branchName;
  const repoStore = getGitRepositoryStore(projectId);
  const defaultBranchName = repoStore?.defaultBranchRef?.branch ?? null;
  const canShowLocalMerge = Boolean(
    currentBranchName && defaultBranchName && currentBranchName !== defaultBranchName
  );

  const linesAdded = gitCheckout.totalLinesAdded;
  const linesDeleted = gitCheckout.totalLinesDeleted;
  const hasChanges = linesAdded > 0 || linesDeleted > 0;

  const scriptTabs = lifecycleScriptsMgr?.tabs ?? [];
  const servers = previews.servers;
  const allConversations = Array.from(conversations.conversations.values()).filter(
    (c) => !isSupersededConversation(c.data.id)
  );

  const handleOpenFolder = () => {
    if (!workspacePath) return;
    void getHostClient().then((client) =>
      client.openIn({
        app: 'finder',
        path: workspacePath,
        isRemote: isRemoteProject,
        sshConnectionId: workspace.sshConnectionId ?? undefined,
      })
    );
  };

  const handleCopyBranch = () => {
    if (!currentBranchName) return;
    void copyTextToClipboard(currentBranchName);
    setCopiedBranch(true);
    window.setTimeout(() => setCopiedBranch(false), 1500);
  };

  const handleRunScript = (scriptId: string) => {
    lifecycleScriptsMgr?.setActiveTab(scriptId);
    taskView.chrome.commands.openTerminalDrawer();
  };

  const handleOpenServer = (url: string) => {
    browserRightPanelStore.openTab(
      {
        projectId,
        workspaceId: taskPayload.workspaceId ?? taskId,
        taskId,
      },
      { initialUrl: url }
    );
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background px-3 py-3 text-sm text-foreground">
      <div className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-background-1">
        {/* Bölüm 1: Ortam, Editörle Aç ve Proje Scriptleri */}
        <div className="flex flex-col gap-0.5 p-2">
          <div className="flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-xs text-foreground-muted">
            <span className="flex min-w-0 items-center gap-2.5">
              <Laptop className="size-4 shrink-0 text-foreground-passive" />
              <span className="truncate font-medium text-foreground">
                {isRemoteProject ? `${projectName} (SSH)` : 'Yerel Mac'}
              </span>
            </span>
            {workspacePath && !isFreeChat ? (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <button
                      type="button"
                      onClick={handleOpenFolder}
                      aria-label="Klasörü Finder ile aç"
                      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-passive transition-colors hover:bg-background-2 hover:text-foreground"
                    >
                      <Folder className="size-3.5" />
                    </button>
                  }
                />
                <Tooltip.Content side="left">Klasörü aç</Tooltip.Content>
              </Tooltip.Root>
            ) : null}
          </div>

          {workspacePath && !isFreeChat ? (
            <div className="flex h-8 items-center rounded-lg px-1 transition-colors hover:bg-background-2/70">
              <OpenInMenu
                path={workspacePath}
                borderless
                isRemote={isRemoteProject}
                sshConnectionId={workspace.sshConnectionId ?? undefined}
                className="h-7 w-full justify-between text-xs text-foreground"
              />
            </div>
          ) : null}

          {!isFreeChat ? (
            <div className="flex flex-col gap-0.5">
              {scriptTabs.map((script) => (
                <button
                  key={script.data.id}
                  type="button"
                  onClick={() => handleRunScript(script.data.id)}
                  className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs text-foreground transition-colors hover:bg-background-2"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Play className="size-3.5 shrink-0 text-foreground-passive" />
                    <span className="truncate">{script.data.label}</span>
                  </span>
                  <span className="text-[11px] text-foreground-passive">Çalıştır</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => navigate(projectViewDef({ projectId }))}
                className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-xs text-foreground-muted transition-colors hover:bg-background-2 hover:text-foreground"
              >
                <Plus className="size-3.5 shrink-0 text-foreground-passive" />
                <span>Proje script&apos;i ekle</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Bölüm 2: Git Branch, Durum ve Değişiklikler */}
        {!isFreeChat ? (
          <div className="flex flex-col gap-0.5 p-2">
            {/* Branch satırı */}
            <div className="flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-xs transition-colors hover:bg-background-2/60">
              <span className="flex min-w-0 items-center gap-2.5">
                <GitBranch className="size-4 shrink-0 text-foreground-passive" />
                <span className="truncate font-mono text-xs text-foreground">
                  {currentBranchName ?? 'detached HEAD'}
                </span>
              </span>
              {currentBranchName ? (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <button
                        type="button"
                        onClick={handleCopyBranch}
                        aria-label="Branch adını kopyala"
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-passive transition-colors hover:bg-background-3 hover:text-foreground"
                      >
                        {copiedBranch ? (
                          <Check className="size-3.5 text-foreground-success" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    }
                  />
                  <Tooltip.Content side="left">
                    {copiedBranch ? 'Kopyalandı' : 'Branch adını kopyala'}
                  </Tooltip.Content>
                </Tooltip.Root>
              ) : null}
            </div>

            {/* Git Aksiyonları satırı */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background-2"
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <Check
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          hasChanges ? 'text-foreground-warning' : 'text-foreground-success'
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">
                          {hasChanges
                            ? 'Commit bekleyen değişiklikler'
                            : isPublished
                              ? 'Çalışma alanı temiz'
                              : 'Yerel branch (yayınlanmadı)'}
                        </span>
                        <span className="truncate text-[11px] text-foreground-passive">
                          {aheadCount > 0 || behindCount > 0
                            ? `${aheadCount > 0 ? `↑${aheadCount} gönderilecek` : ''}${aheadCount > 0 && behindCount > 0 ? ' · ' : ''}${behindCount > 0 ? `↓${behindCount} çekilecek` : ''}`
                            : isPublished
                              ? 'Uzak depo ile senkron'
                              : 'Yayınlamak için tıklayın'}
                        </span>
                      </span>
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
                  </button>
                }
              />
              <DropdownMenu.Content align="end" className="min-w-48">
                <DropdownMenu.Item onClick={() => taskView.chrome.commands.openSidebarTab('changes')}>
                  <FileDiff className="size-3.5" />
                  Değişiklikleri ve Commit panelini aç
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={isFetching} onClick={fetch}>
                  <RefreshCcw className="size-3.5" />
                  Fetch
                </DropdownMenu.Item>
                {isPublished ? (
                  <>
                    <DropdownMenu.Item disabled={isPulling} onClick={pull}>
                      <ArrowDown className="size-3.5" />
                      Pull {behindCount > 0 ? `(${behindCount})` : ''}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={isPushing} onClick={push}>
                      <ArrowUp className="size-3.5" />
                      Push {aheadCount > 0 ? `(${aheadCount})` : ''}
                    </DropdownMenu.Item>
                  </>
                ) : (
                  <DropdownMenu.Item disabled={isPublishing} onClick={publish}>
                    <ArrowUp className="size-3.5" />
                    Branch&apos;i Yayınla
                  </DropdownMenu.Item>
                )}
                {canShowLocalMerge ? (
                  <DropdownMenu.Item onClick={() => setMergeDialogOpen(true)}>
                    <GitMerge className="size-3.5" />
                    {defaultBranchName} ile birleştir…
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Değişiklikler satırı */}
            <button
              type="button"
              onClick={() => taskView.chrome.commands.openSidebarTab('changes')}
              className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-background-2"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <FileDiff className="size-4 shrink-0 text-foreground-passive" />
                <span className="truncate font-medium text-foreground">Değişiklikler</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
                <span
                  className={cn(
                    linesAdded > 0 ? 'text-foreground-diff-added' : 'text-foreground-passive'
                  )}
                >
                  +{formatDiffLineCount(linesAdded)}
                </span>
                <span
                  className={cn(
                    linesDeleted > 0 ? 'text-foreground-diff-deleted' : 'text-foreground-passive'
                  )}
                >
                  -{formatDiffLineCount(linesDeleted)}
                </span>
              </span>
            </button>
          </div>
        ) : null}

        {/* Bölüm 3: Sunucular */}
        <div className="flex flex-col gap-1 p-2">
          <div className="px-2 pt-0.5 text-[11px] font-medium text-foreground-passive">
            Sunucular
          </div>
          {servers.length === 0 ? (
            <div className="flex h-7 items-center gap-2 px-2 text-xs text-foreground-passive">
              <Server className="size-3.5 shrink-0 opacity-60" />
              <span>Çalışan yerel sunucu yok</span>
            </div>
          ) : (
            servers.map((server) => {
              const url = previewServerUrl(server);
              return (
                <button
                  key={server.id}
                  type="button"
                  disabled={!url}
                  onClick={() => {
                    if (url) handleOpenServer(url);
                  }}
                  onAuxClick={() => {
                    if (url) void openExternal(url);
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-background-2 disabled:cursor-default disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Globe className="size-4 shrink-0 text-foreground-passive" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium text-foreground">
                        {formatPreviewServerLabel(server)}
                      </span>
                      <span className="truncate text-[11px] text-foreground-passive">
                        {url ?? server.status.kind}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-foreground-passive" />
                </button>
              );
            })
          )}
        </div>

        {/* Bölüm 4: Soy ağacı / Önceki ajanlar */}
        <div className="flex flex-col gap-1 p-2">
          <div className="flex items-center justify-between px-2 pt-0.5">
            <span className="text-[11px] font-medium text-foreground-passive">Soy ağacı</span>
            <button
              type="button"
              onClick={() => taskView.chrome.commands.openSidebarTab('conversations')}
              className="cursor-pointer text-[11px] text-foreground-passive transition-colors hover:text-foreground"
            >
              Tümü
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowLineageList((prev) => !prev)}
            className="flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-background-2"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Bot className="size-4 shrink-0 text-foreground-passive" />
              <span className="truncate font-medium text-foreground">Önceki ajanlar</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-foreground-passive">
              <span>{allConversations.length}</span>
              <ChevronRight
                className={cn('size-3.5 transition-transform', showLineageList && 'rotate-90')}
              />
            </span>
          </button>

          {showLineageList && allConversations.length > 0 ? (
            <div className="mt-0.5 flex flex-col gap-0.5 pl-2">
              {allConversations.slice(0, 8).map((conv) => (
                <LineageConversationRow
                  key={conv.data.id}
                  conv={conv}
                  isSessionActive={conversations.isSessionActive(conv.data.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {canShowLocalMerge && currentBranchName && defaultBranchName ? (
        <LocalMergeDialog
          open={mergeDialogOpen}
          onOpenChange={setMergeDialogOpen}
          projectId={projectId}
          taskId={taskId}
          taskName={taskDisplayName(taskStore) ?? taskPayload.name}
          sourceBranch={currentBranchName}
          targetBranch={defaultBranchName}
          hasUncommittedChanges={gitCheckout.fileChanges.length > 0}
        />
      ) : null}
    </div>
  );
});

const LineageConversationRow = observer(function LineageConversationRow({
  conv,
  isSessionActive,
}: {
  conv: ConversationStore;
  isSessionActive: boolean;
}) {
  const kind = conversationTabKind(conv.data.type);
  const title = conversationTabTitle(conv);
  const { isActive, open } = useTabSelection(kind, conv.data.id);

  return (
    <button
      type="button"
      onClick={() => open({ conversationId: conv.data.id }, { preview: false })}
      className={cn(
        'flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-background-2 hover:text-foreground',
        isActive ? 'bg-background-2 text-foreground' : 'text-foreground-muted'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ConversationAgentIcon
          providerId={conv.data.providerId ?? ''}
          isAcp={conv.data.type === 'acp'}
          size={14}
          className="shrink-0"
        />
        <span className="truncate">{title}</span>
      </span>
      {isSessionActive ? (
        <span className="size-1.5 shrink-0 rounded-full bg-foreground-success" />
      ) : null}
    </button>
  );
});
