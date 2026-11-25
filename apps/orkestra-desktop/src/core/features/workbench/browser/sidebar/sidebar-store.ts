import { computed, makeAutoObservable, observable, reaction } from 'mobx';
import {
  taskAgentStatus,
  taskConversationStats,
} from '@core/features/conversations/api/browser/conversation-selectors';
import { type ProjectStore } from '@core/features/projects/api/browser/stores/project';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import { asAvailableProject } from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitCheckoutStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import {
  workbenchSidebarMemento,
  type WorkbenchSidebarState,
} from '@core/features/workbench/contributions/mementos';
import type { Conversation, ConversationEvent } from '@core/primitives/conversations/api';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { FREE_CHAT_PROJECT_ID, isFreeChatProjectId } from '@core/primitives/projects/api';
import {
  registeredTaskData,
  unregisteredTaskData,
} from '@core/primitives/task-state/browser/task-state';
import {
  dropFreeChat,
  moveFreeChatBy as moveFreeChatIdBy,
  orderFreeChats,
} from './free-chat-order';
export type SidebarTaskSortBy = WorkbenchSidebarState['taskSortBy'];
export type SidebarStatusFilter = 'all' | 'active' | 'settled';

/** Collapsible sidebar sections whose open/closed state persists in the sidebar memento. */
export type SidebarSectionId = keyof NonNullable<WorkbenchSidebarState['sectionOpen']>;

export const SIDEBAR_SECTION_DEFAULT_OPEN: Readonly<Record<SidebarSectionId, boolean>> = {
  freeChats: true,
  externalSessions: true,
  settled: false,
  snoozed: false,
  waiting: true,
};

const PROVIDER_SEARCH_ALIASES: Record<string, string> = {
  antigravity: 'antigravity',
  claude: 'claude code',
  codex: 'codex',
  gemini: 'gemini cli',
  glm: 'glm / z.ai',
  grok: 'grok',
  kimi: 'kimi',
  opencode: 'opencode',
  orchestra: 'orkestra',
};

export type TaskSortKind = 'created' | 'updated';

export function sortKindFor(sortBy: SidebarTaskSortBy): TaskSortKind {
  return sortBy === 'created-at' ? 'created' : 'updated';
}

export function getSortInstant(task: TaskStore, kind: TaskSortKind): string | undefined {
  const reg = registeredTaskData(task);
  if (reg) {
    if (kind === 'created') return reg.createdAt;
    return reg.lastInteractedAt ?? reg.updatedAt;
  }
  const u = unregisteredTaskData(task);
  if (u) {
    if (kind === 'created') return u.createdAt;
    return u.lastInteractedAt;
  }
  return undefined;
}

function isArchivedRegularTask(task: TaskStore): boolean {
  return (
    task.data.type !== 'automation-run' &&
    task.state !== 'unregistered' &&
    'archivedAt' in task.data &&
    Boolean(task.data.archivedAt)
  );
}

function isVisibleRegularTask(task: TaskStore): boolean {
  return (
    task.data.type !== 'automation-run' &&
    (task.state === 'unregistered' || !('archivedAt' in task.data && task.data.archivedAt))
  );
}

function getTaskBranchForFilter(task: TaskStore): string | undefined {
  if (task.workspaceId) {
    const branchName = getGitCheckoutStore(task.workspaceId)?.branchName;
    if (branchName) return branchName;
  }
  if (task.workspaceObservedPr?.branch) {
    return task.workspaceObservedPr.branch;
  }
  if (
    'taskBranch' in task.data &&
    typeof task.data.taskBranch === 'string' &&
    task.data.taskBranch
  ) {
    return task.data.taskBranch;
  }
  return undefined;
}

function taskMatchesTextQuery(task: TaskStore, query: string, projectName?: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  if (task.data.name.toLowerCase().includes(normalized)) return true;
  if (projectName && projectName.toLowerCase().includes(normalized)) return true;

  const branch = getTaskBranchForFilter(task);
  if (branch && branch.toLowerCase().includes(normalized)) return true;

  const stats = taskConversationStats(task);
  if (stats) {
    for (const providerId of Object.keys(stats)) {
      if (providerId.toLowerCase().includes(normalized)) return true;
      const alias = PROVIDER_SEARCH_ALIASES[providerId];
      if (alias && alias.includes(normalized)) return true;
    }
  }

  return false;
}

export function taskMatchesFilter(
  task: TaskStore,
  query: string,
  statusFilter: SidebarStatusFilter,
  projectName?: string
): boolean {
  if (!isVisibleRegularTask(task)) return false;

  if (statusFilter === 'active' && taskAgentStatus(task) === null) return false;
  if (statusFilter === 'settled' && taskAgentStatus(task) !== null) return false;

  return taskMatchesTextQuery(task, query, projectName);
}

type TaskEntry = { projectId: string; taskId: string };
type WaitingEntry = TaskEntry & { conversationId: string; reason: 'awaiting-input' | 'error' };

export type SidebarRow =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

export class SidebarStore {
  private _handle: MementoHandle<WorkbenchSidebarState> | undefined;
  private _fallbackState: WorkbenchSidebarState = workbenchSidebarMemento.default;
  private stopSnoozeTimer: (() => void) | undefined;
  private readonly attention = observable.map<string, WaitingEntry>();
  private readonly _revealedProjectIds = observable.set<string>();

  searchQuery = '';
  statusFilter: SidebarStatusFilter = 'all';

  constructor(private readonly projectManager: ProjectManagerStore) {
    // `_handle` must stay observable: computeds reading `state` before the
    // memento handle is attached would otherwise capture zero dependencies
    // and freeze at the fallback value forever.
    makeAutoObservable<
      SidebarStore,
      | '_fallbackState'
      | 'attention'
      | '_handle'
      | '_revealedProjectIds'
      | 'stopSnoozeTimer'
      | 'projectManager'
      | 'orderedFreeChatTasks'
      | 'freeChatOrderIds'
    >(this, {
      _fallbackState: false,
      attention: false,
      _handle: observable.ref,
      _revealedProjectIds: false,
      projectManager: false,
      stopSnoozeTimer: false,
      expandedProjectIds: computed.struct,
      effectiveExpandedProjectIds: computed.struct,
      sidebarRows: computed,
      pinnedSidebarEntries: computed,
      freeChatEntries: computed,
      hasActiveFilter: computed,
      canReorderFreeChats: computed,
      orderedFreeChatTasks: computed,
      freeChatOrderIds: computed.struct,
      settledEntries: computed,
    });
  }

  setSearchQuery(q: string): void {
    this.searchQuery = q;
  }

  setStatusFilter(f: SidebarStatusFilter): void {
    this.statusFilter = f;
  }

  get projectOrder(): string[] {
    return this.state.projectOrder;
  }

  get taskOrderByProject(): Record<string, string[]> {
    return this.state.taskOrderByProject;
  }

  get expandedProjectIds(): ReadonlySet<string> {
    return new Set([...this.state.expandedProjectIds, ...this._revealedProjectIds]);
  }

  get effectiveExpandedProjectIds(): ReadonlySet<string> {
    const query = this.searchQuery.trim();
    if (!query && this.statusFilter === 'all') {
      return this.expandedProjectIds;
    }

    const expanded = new Set<string>(this.expandedProjectIds);
    for (const project of this.orderedProjects) {
      const context = asAvailableProject(project);
      if (!context) continue;
      const projectName = project.name ?? '';
      const hasMatchingTask = Array.from(context.get(taskManagerStoreToken).tasks.values()).some(
        (task) =>
          !task.data.isPinned &&
          !this.isSnoozed(task.data.id) &&
          taskMatchesFilter(task, this.searchQuery, this.statusFilter, projectName)
      );
      if (hasMatchingTask) {
        expanded.add(project.id);
      }
    }
    return expanded;
  }

  get taskSortBy(): SidebarTaskSortBy {
    return this.state.taskSortBy;
  }

  attachMemento(handle: MementoHandle<WorkbenchSidebarState>): void {
    if (this._handle) throw new Error('Sidebar memento is already attached');
    this._handle = handle;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (deadline: number | undefined) => {
      clearTimeout(timer);
      if (deadline === undefined) return;
      const delay = Math.max(0, deadline - Date.now());
      timer = setTimeout(
        () => {
          if (Date.now() >= deadline) this.expireSnoozes();
          else schedule(deadline);
        },
        Math.min(2_147_483_647, delay)
      );
    };
    const stop = reaction(() => this.nextSnoozeDeadline, schedule, { fireImmediately: true });
    this.stopSnoozeTimer = () => {
      stop();
      clearTimeout(timer);
    };
    this.expireSnoozes();
  }

  dispose(): void {
    this.stopSnoozeTimer?.();
  }

  isSnoozed(taskId: string): boolean {
    return Boolean(this.state.snoozedTasks?.[taskId]);
  }

  snoozeTask(projectId: string, taskId: string, until: number): void {
    const since = Date.now();
    if (!Number.isSafeInteger(until) || until <= since) return;
    this.updateState((current) => ({
      ...current,
      snoozedTasks: { ...current.snoozedTasks, [taskId]: { projectId, since, until } },
    }));
  }

  restoreSnoozedTask(taskId: string): void {
    if (!this.isSnoozed(taskId)) return;
    this.updateState((current) => {
      const snoozedTasks = { ...current.snoozedTasks };
      delete snoozedTasks[taskId];
      return { ...current, snoozedTasks };
    });
  }

  handleConversationEvent(event: ConversationEvent): void {
    if (event.type === 'deleted' || event.type === 'seen') {
      this.attention.delete(event.conversationId);
      return;
    }
    if (event.type === 'created') {
      this.applyConversationSnapshot(event.conversation);
      return;
    }
    if (event.type !== 'agent-status-changed') return;
    const { projectId, taskId, conversationId, status, seen, attentionAt } = event;
    if (!seen && (status === 'awaiting-input' || status === 'error')) {
      this.attention.set(conversationId, { projectId, taskId, conversationId, reason: status });
    } else {
      this.attention.delete(conversationId);
    }
    if (attentionAt === undefined) return;
    const snooze = this.state.snoozedTasks?.[event.taskId];
    if (snooze?.projectId === event.projectId && attentionAt >= snooze.since) {
      this.restoreSnoozedTask(event.taskId);
    }
  }

  applyConversationSnapshot(conversation: Conversation): void {
    const { projectId, taskId, id, agentStatus, agentStatusSeen } = conversation;
    if (!agentStatusSeen && (agentStatus === 'awaiting-input' || agentStatus === 'error')) {
      this.attention.set(id, { projectId, taskId, conversationId: id, reason: agentStatus });
    }
  }

  clearProjectAttention(projectId: string, except?: ReadonlySet<string>): void {
    for (const [id, entry] of this.attention) {
      if (entry.projectId === projectId && !except?.has(id)) this.attention.delete(id);
    }
  }

  replaceProjectAttention(
    projectId: string,
    conversations: Conversation[],
    liveIds: ReadonlySet<string>
  ): void {
    this.clearProjectAttention(projectId, liveIds);
    for (const conversation of conversations) {
      if (!liveIds.has(conversation.id)) this.applyConversationSnapshot(conversation);
    }
  }

  private get nextSnoozeDeadline(): number | undefined {
    let next: number | undefined;
    for (const { until } of Object.values(this.state.snoozedTasks ?? {})) {
      next = Math.min(next ?? until, until);
    }
    return next;
  }

  private expireSnoozes(now = Date.now()): void {
    if (this.nextSnoozeDeadline === undefined || this.nextSnoozeDeadline > now) return;
    this.updateState((current) => ({
      ...current,
      snoozedTasks: Object.fromEntries(
        Object.entries(current.snoozedTasks ?? {}).filter(([, snooze]) => snooze.until > now)
      ),
    }));
  }

  get snoozedEntries(): (TaskEntry & { until: number })[] {
    const entries: (TaskEntry & { until: number })[] = [];
    for (const [taskId, { projectId, until }] of Object.entries(this.state.snoozedTasks ?? {})) {
      const project = this.projectManager.projects.get(projectId);
      const task = asAvailableProject(project)?.get(taskManagerStoreToken).tasks.get(taskId);
      if (
        task &&
        isVisibleRegularTask(task) &&
        taskMatchesFilter(task, this.searchQuery, this.statusFilter, project?.name ?? undefined)
      ) {
        entries.push({ projectId, taskId, until });
      }
    }
    return entries.sort((a, b) => a.until - b.until);
  }

  get waitingEntries(): WaitingEntry[] {
    if (this.statusFilter === 'settled') return [];
    return [...this.attention.values()].filter(({ projectId, taskId }) => {
      const project = this.projectManager.projects.get(projectId);
      const task = asAvailableProject(project)?.get(taskManagerStoreToken).tasks.get(taskId);
      return (
        task !== undefined &&
        isVisibleRegularTask(task) &&
        !this.isSnoozed(taskId) &&
        taskMatchesTextQuery(task, this.searchQuery, project?.name ?? undefined)
      );
    });
  }

  get orderedProjects(): ProjectStore[] {
    const all = Array.from(this.projectManager.projects.values()).filter(
      (project) => !isFreeChatProjectId(project.id)
    );

    return [...all].sort((a, b) => {
      const ai = this.projectOrder.indexOf(a.id);
      const bi = this.projectOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return this.compareSidebarProjects(a, b);
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }

  get sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    const normalizedQuery = this.searchQuery.trim().toLowerCase();
    const hasQuery = normalizedQuery.length > 0;
    const hasFilter = hasQuery || this.statusFilter !== 'all';
    const expanded = this.effectiveExpandedProjectIds;

    for (const project of this.orderedProjects) {
      const projectId = project.id;
      const projectName = project.name ?? '';
      const context = asAvailableProject(project);
      const visibleUnpinned = context
        ? this.orderedUnpinnedTasksForProject(projectId, context).filter(
            (task) => !this.isSnoozed(task.data.id)
          )
        : [];
      const filteredTasks = hasFilter
        ? visibleUnpinned.filter((task) =>
            taskMatchesFilter(task, this.searchQuery, this.statusFilter, projectName)
          )
        : visibleUnpinned;

      if (hasFilter) {
        const projectMatchesQuery = hasQuery && projectName.toLowerCase().includes(normalizedQuery);
        const includeProject =
          filteredTasks.length > 0 || (projectMatchesQuery && this.statusFilter === 'all');
        if (!includeProject) continue;
      }

      rows.push({ kind: 'project', projectId });
      if (expanded.has(projectId) && context) {
        for (const task of filteredTasks) {
          rows.push({ kind: 'task', projectId, taskId: task.data.id });
        }
      }
    }
    return rows;
  }

  /** Visible unpinned tasks in the same order they are rendered in the project tree. */
  get visibleTaskEntries(): { projectId: string; taskId: string }[] {
    return this.sidebarRows
      .filter((row): row is Extract<SidebarRow, { kind: 'task' }> => row.kind === 'task')
      .map(({ projectId, taskId }) => ({ projectId, taskId }));
  }

  /** Flat list of pinned tasks from available Project contexts, in project-tree sort order. */
  get pinnedSidebarEntries(): { projectId: string; taskId: string }[] {
    const pairs: { projectId: string; task: TaskStore }[] = [];
    const hasFilter = this.searchQuery.trim().length > 0 || this.statusFilter !== 'all';
    for (const project of this.projectManager.projects.values()) {
      const context = asAvailableProject(project);
      if (!context) continue;
      const projectId = project.id;
      const projectName = isFreeChatProjectId(projectId) ? undefined : (project.name ?? undefined);
      for (const task of context.get(taskManagerStoreToken).tasks.values()) {
        if (!isVisibleRegularTask(task) || !task.data.isPinned || this.isSnoozed(task.data.id))
          continue;
        if (
          hasFilter &&
          !taskMatchesFilter(task, this.searchQuery, this.statusFilter, projectName)
        ) {
          continue;
        }
        pairs.push({ projectId, task });
      }
    }
    pairs.sort((a, b) => this.compareSidebarTasks(a.task, b.task));
    return pairs.map(({ projectId, task }) => ({ projectId, taskId: task.data.id }));
  }

  /**
   * Serbest sohbetler ("Sohbetler" dahili projesi altındaki arşivlenmemiş, sabitlenmemiş
   * konuşmalar). Sıra `free-chat-order.ts` kuralını izler: elle yerleştirilmemiş (yeni) sohbetler
   * en yeni üstte, ardından kullanıcının kalıcı elle sırası. Filtre/arama aynı sırayı daraltır.
   */
  get freeChatEntries(): { projectId: string; taskId: string }[] {
    const hasFilter = this.hasActiveFilter;
    return this.orderedFreeChatTasks
      .filter(
        (task) =>
          !this.isSnoozed(task.data.id) &&
          (!hasFilter || taskMatchesFilter(task, this.searchQuery, this.statusFilter))
      )
      .map((t) => ({ projectId: FREE_CHAT_PROJECT_ID, taskId: t.data.id }));
  }

  /** Arama veya durum filtresi etkin mi? Etkinken "Sohbetler" elle sıralanamaz. */
  get hasActiveFilter(): boolean {
    return this.searchQuery.trim().length > 0 || this.statusFilter !== 'all';
  }

  /** Elle sıralama yalnızca filtre yokken ve en az iki sohbet varken açıktır. */
  get canReorderFreeChats(): boolean {
    return !this.hasActiveFilter && this.freeChatEntries.length > 1;
  }

  /** Sürükle-bırak: `taskId` sohbetini `overTaskId` satırının üstüne/altına taşır ve kalıcı yazar. */
  dropFreeChat(taskId: string, overTaskId: string, placeAbove: boolean): boolean {
    if (!this.canReorderFreeChats) return false;
    const next = dropFreeChat(
      this.freeChatEntries.map((entry) => entry.taskId),
      taskId,
      overTaskId,
      placeAbove
    );
    if (!next) return false;
    this.setVisibleTaskOrder(FREE_CHAT_PROJECT_ID, this.freeChatOrderIds, next);
    return true;
  }

  /** Klavye/menü: sohbeti bir adım yukarı (-1) veya aşağı (+1) taşır ve kalıcı yazar. */
  moveFreeChatBy(taskId: string, delta: -1 | 1): boolean {
    if (!this.canReorderFreeChats) return false;
    const next = moveFreeChatIdBy(
      this.freeChatEntries.map((entry) => entry.taskId),
      taskId,
      delta
    );
    if (!next) return false;
    this.setVisibleTaskOrder(FREE_CHAT_PROJECT_ID, this.freeChatOrderIds, next);
    return true;
  }

  setVisibleTaskOrder(projectId: string, allIds: string[], visibleIds: string[]): void {
    const reorderedIds = new Set(visibleIds);
    let nextVisible = 0;
    this.setTaskOrder(
      projectId,
      allIds.map((id) => (reorderedIds.has(id) ? (visibleIds[nextVisible++] ?? id) : id))
    );
  }

  private get freeChatOrderIds(): string[] {
    return this.orderedFreeChatTasks.map((task) => task.data.id);
  }

  private get orderedFreeChatTasks(): TaskStore[] {
    const project = this.projectManager.projects.get(FREE_CHAT_PROJECT_ID);
    if (!project) return [];
    const context = asAvailableProject(project);
    if (!context) return [];
    const tasks = Array.from(context.get(taskManagerStoreToken).tasks.values()).filter(
      (task) => isVisibleRegularTask(task) && !task.data.isPinned
    );
    const items = tasks.map((task) => ({
      id: task.data.id,
      createdAt: getSortInstant(task, 'created'),
      task,
    }));
    return orderFreeChats(items, this.taskOrderByProject[FREE_CHAT_PROJECT_ID]).map(
      (item) => item.task
    );
  }

  /** Arşivlenmiş düzenli görevler ("Tamamlananlar"), arama sorgusuna göre filtrelenmiş ve tarihçe azalan sırada. */
  get settledEntries(): { projectId: string; taskId: string }[] {
    if (this.statusFilter === 'active') return [];
    const pairs: { projectId: string; task: TaskStore }[] = [];
    for (const project of this.projectManager.projects.values()) {
      const context = asAvailableProject(project);
      if (!context) continue;
      const projectId = project.id;
      const projectName = isFreeChatProjectId(projectId) ? undefined : (project.name ?? undefined);
      for (const task of context.get(taskManagerStoreToken).tasks.values()) {
        if (!isArchivedRegularTask(task)) continue;
        if (!taskMatchesTextQuery(task, this.searchQuery, projectName)) continue;
        pairs.push({ projectId, task });
      }
    }
    pairs.sort((a, b) => this.compareSettledTasks(a.task, b.task));
    return pairs.map(({ projectId, task }) => ({ projectId, taskId: task.data.id }));
  }

  /**
   * Visible unpinned task IDs for a project in sidebar order. Archived tasks are
   * and automation tasks are excluded. Independent of expand state so Next/Previous
   * Task navigation works even when the project is collapsed.
   */
  visibleTaskIdsForProject(projectId: string): string[] {
    return this.taskIdsForProject(projectId).filter((id) => !this.isSnoozed(id));
  }

  taskIdsForProject(projectId: string): string[] {
    const project = this.projectManager.projects.get(projectId);
    if (!project) return [];
    const context = asAvailableProject(project);
    if (!context) return [];
    return this.orderedUnpinnedTasksForProject(projectId, context).map((t) => t.data.id);
  }

  get isEmpty(): boolean {
    if (this.orderedProjects.length > 0) return false;
    const freeProject = this.projectManager.projects.get(FREE_CHAT_PROJECT_ID);
    const context = freeProject ? asAvailableProject(freeProject) : undefined;
    if (!context) return true;
    for (const task of context.get(taskManagerStoreToken).tasks.values()) {
      if (isVisibleRegularTask(task) || isArchivedRegularTask(task)) return false;
    }
    return true;
  }

  private orderedUnpinnedTasksForProject(
    projectId: string,
    context: NonNullable<ReturnType<typeof asAvailableProject>>
  ): TaskStore[] {
    const tasks = Array.from(context.get(taskManagerStoreToken).tasks.values()).filter(
      (task) => isVisibleRegularTask(task) && !task.data.isPinned
    );
    const manualOrder = this.taskOrderByProject[projectId];
    return manualOrder?.length
      ? this.mergeTaskOrder(projectId, tasks)
      : this.sortTasksForSidebar(tasks);
  }

  /** Called on first load when no snapshot exists — expand all known projects. */
  expandAllProjects(): void {
    this.updateState((current) => ({
      ...current,
      expandedProjectIds: this.orderedProjects.map((project) => project.id),
    }));
  }

  toggleProjectExpanded(projectId: string): void {
    const isPersisted = this.state.expandedProjectIds.includes(projectId);
    const isRevealed = this._revealedProjectIds.has(projectId);
    if (isPersisted || isRevealed) {
      this._revealedProjectIds.delete(projectId);
      if (isPersisted) {
        this.updateExpandedProjects((ids) => ids.filter((id) => id !== projectId));
      }
      return;
    }
    this.updateExpandedProjects((ids) => [...ids, projectId]);
  }

  revealProject(projectId: string): void {
    if (!this.expandedProjectIds.has(projectId)) {
      this._revealedProjectIds.add(projectId);
    }
  }

  setTaskSortBy(sortBy: SidebarTaskSortBy): void {
    this.updateState((current) => ({ ...current, taskSortBy: sortBy }));
  }

  /**
   * Set the sort key and clear all manual task orders so the list fully re-sorts. The free-chat
   * order is kept: "Sohbetler" ignores the sort key, so resetting it would only lose the user's
   * hand-placed order.
   */
  applySort(sortBy: SidebarTaskSortBy): void {
    this.updateState((current) => {
      const freeChatOrder = current.taskOrderByProject[FREE_CHAT_PROJECT_ID];
      const taskOrderByProject: Record<string, string[]> = {};
      if (freeChatOrder) taskOrderByProject[FREE_CHAT_PROJECT_ID] = freeChatOrder;
      return {
        ...current,
        taskSortBy: sortBy,
        taskOrderByProject,
      };
    });
  }

  isSectionOpen(section: SidebarSectionId): boolean {
    return this.state.sectionOpen?.[section] ?? SIDEBAR_SECTION_DEFAULT_OPEN[section];
  }

  toggleSectionOpen(section: SidebarSectionId): void {
    const next = !this.isSectionOpen(section);
    this.updateState((current) => ({
      ...current,
      sectionOpen: { ...current.sectionOpen, [section]: next },
    }));
  }

  /**
   * One-time adoption of section open states persisted by an older build outside the memento.
   * Only sections the memento has never stored are taken over, so a repeated call (or a stale
   * legacy value) can never overwrite a choice made since. Returns the adopted section ids.
   */
  adoptLegacySectionOpen(legacy: Partial<Record<SidebarSectionId, boolean>>): SidebarSectionId[] {
    const stored = this.state.sectionOpen ?? {};
    const adopted = (Object.keys(SIDEBAR_SECTION_DEFAULT_OPEN) as SidebarSectionId[]).filter(
      (section) => stored[section] === undefined && typeof legacy[section] === 'boolean'
    );
    if (adopted.length === 0) return [];
    this.updateState((current) => {
      const sectionOpen = { ...current.sectionOpen };
      for (const section of adopted) sectionOpen[section] = legacy[section];
      return { ...current, sectionOpen };
    });
    return adopted;
  }

  setProjectOrder(ids: string[]): void {
    this.updateState((current) => ({ ...current, projectOrder: ids }));
  }

  mergeTaskOrder(projectId: string, tasks: TaskStore[]): TaskStore[] {
    const stored = this.taskOrderByProject[projectId] ?? [];
    const byId = new Map(tasks.map((t) => [t.data.id, t] as const));
    const seen = new Set<string>();
    const result: TaskStore[] = [];
    for (const id of stored) {
      const t = byId.get(id);
      if (t) {
        result.push(t);
        seen.add(id);
      }
    }
    // New tasks (not in the manual order) are sorted by date and prepended so
    // they always appear at the top rather than buried after manually-ordered tasks.
    const newTasks = tasks
      .filter((t) => !seen.has(t.data.id))
      .sort((a, b) => this.compareSidebarTasks(a, b));
    return [...newTasks, ...result];
  }

  setTaskOrder(projectId: string, orderedIds: string[]): void {
    this.updateState((current) => ({
      ...current,
      taskOrderByProject: { ...current.taskOrderByProject, [projectId]: orderedIds },
    }));
  }

  private get state(): WorkbenchSidebarState {
    return this._handle?.value ?? this._fallbackState;
  }

  private updateState(update: (current: WorkbenchSidebarState) => WorkbenchSidebarState): void {
    if (this._handle) {
      this._handle.update(update);
    } else {
      this._fallbackState = update(this._fallbackState);
    }
  }

  private updateExpandedProjects(update: (current: string[]) => string[]): void {
    this.updateState((current) => ({
      ...current,
      expandedProjectIds: update(current.expandedProjectIds),
    }));
  }

  private getSettledInstant(task: TaskStore): string {
    const reg = registeredTaskData(task);
    if (!reg) return '';
    return reg.archivedAt ?? reg.lastInteractedAt ?? reg.updatedAt ?? reg.createdAt;
  }

  private compareSettledTasks(a: TaskStore, b: TaskStore): number {
    const ia = this.getSettledInstant(a);
    const ib = this.getSettledInstant(b);
    const d = ib.localeCompare(ia);
    if (d !== 0) return d;
    return a.data.id.localeCompare(b.data.id);
  }

  private compareSidebarTasks(a: TaskStore, b: TaskStore): number {
    const kind = sortKindFor(this.taskSortBy);
    const ia = getSortInstant(a, kind) ?? '';
    const ib = getSortInstant(b, kind) ?? '';
    const d = ib.localeCompare(ia);
    if (d !== 0) return d;
    return a.data.id.localeCompare(b.data.id);
  }

  private compareSidebarProjects(a: ProjectStore, b: ProjectStore): number {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }

  private sortTasksForSidebar(tasks: TaskStore[]): TaskStore[] {
    return [...tasks].sort((a, b) => this.compareSidebarTasks(a, b));
  }
}
