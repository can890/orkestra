import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { hostFileRef, type HostFileRef } from '@orkestra/core/primitives/path/api';
import {
  isRuntimeResolveError,
  type HostRuntimesClient,
} from '@orkestra/core/services/runtime-broker/api';
import { err, ok, type Result } from '@orkestra/shared';
import { log } from '@orkestra/shared/logger';
import {
  createLiveJobReplicaCache,
  LiveJobFailedError,
  type LiveJobContext,
} from '@orkestra/wire/live';
import { type JobError, type JobInput, type JobProgress, type JobResult } from '@orkestra/wire/rpc';
import type Database from 'better-sqlite3';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { conversationEvents } from '@core/features/conversations/api/node/conversation-events';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { projectEvents } from '@core/features/projects/api/node/project-events';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { WorkspaceRuntimeAccess } from '@core/features/workspaces/api/node/runtime-access';
import { getProvisionedWorkspaceBranch } from '@core/features/workspaces/api/node/workspace-branch';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Project } from '@core/primitives/projects/api';
import type {
  IndexConversationMessagesInput,
  MessageSearchHit,
  MessageSearchQuery,
  PaletteEntitySearchQuery,
  SearchItem,
  WorkspaceFileHit,
} from '@core/primitives/search/api';
import type { Task } from '@core/primitives/tasks/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { contentSearchRuntimeContract, type searchContract } from '../api';

type FtsRow = {
  item_type: string;
  item_id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  keywords?: string;
  rank: number;
};

type MessageFtsRow = {
  conversation_id: string;
  project_id: string;
  task_id: string;
  item_id: string;
  role: string;
  conversation_title: string;
  content: string;
  snippet?: string;
  rank?: number;
};

type RecentTaskRow = {
  id: string;
  name: string;
  project_id: string;
};

type RecentConversationRow = {
  id: string;
  title: string;
  project_id: string;
  task_id: string;
};

type ParsedDiskMessage = {
  itemId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
};

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const HIDDEN_CONTEXT_RE = /<orkestra_context>[\s\S]*?<\/orkestra_context>/g;
const UNTERMINATED_CONTEXT_RE = /<orkestra_context>[\s\S]*$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const BOILERPLATE_PREFIXES = [
  '# AGENTS.md',
  '<INSTRUCTIONS>',
  '<environment_context>',
  '<external_codex_apps',
  '<permissions instructions>',
  '<user_shell_command>',
  '<local-command',
  '<command-name>',
  '<system-reminder>',
];

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripOrkestraContext(text: string): string {
  const stripped = text.replace(HIDDEN_CONTEXT_RE, '').replace(UNTERMINATED_CONTEXT_RE, '');
  return stripped.trim();
}

function isBoilerplateMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return BOILERPLATE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseTimestampMs(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function buildHighlightedSnippet(content: string, tokens: readonly string[]): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const validTokens = tokens.filter(Boolean);
  if (validTokens.length === 0) {
    return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
  }

  const lower = compact.toLocaleLowerCase();
  let firstMatchIndex = -1;
  for (const token of validTokens) {
    const idx = lower.indexOf(token.toLocaleLowerCase());
    if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
      firstMatchIndex = idx;
    }
  }

  const start = firstMatchIndex > 48 ? firstMatchIndex - 48 : 0;
  const end = Math.min(compact.length, start + 160);
  let slice = compact.slice(start, end);
  if (start > 0) slice = `...${slice}`;
  if (end < compact.length) slice = `${slice}...`;

  const pattern = new RegExp(
    `(${[...validTokens]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})`,
    'gi'
  );
  return slice.replace(pattern, '<mark>$1</mark>');
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function parseAntigravityMessages(raw: string, fallbackTs: number): ParsedDiskMessage[] {
  const out: ParsedDiskMessage[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = parseTimestampMs(obj.timestamp ?? obj.createdAt, fallbackTs);
    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
      const reqStart = obj.content.indexOf('<USER_REQUEST>');
      let extracted = obj.content;
      if (reqStart >= 0) {
        const from = reqStart + '<USER_REQUEST>'.length;
        const reqEnd = obj.content.lastIndexOf('</USER_REQUEST>');
        extracted = obj.content.slice(from, reqEnd >= from ? reqEnd : undefined);
      }
      const clean = stripOrkestraContext(extracted);
      if (!clean || isBoilerplateMessage(clean)) continue;
      out.push({
        itemId: typeof obj.id === 'string' && obj.id ? obj.id : `agy-user-${i}`,
        role: 'user',
        content: clean,
        createdAt: ts,
      });
    } else if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string') {
      const clean = stripOrkestraContext(obj.content);
      if (!clean) continue;
      out.push({
        itemId: typeof obj.id === 'string' && obj.id ? obj.id : `agy-assistant-${i}`,
        role: 'assistant',
        content: clean,
        createdAt: ts,
      });
    }
  }
  return out;
}

function parseClaudeMessages(raw: string, fallbackTs: number): ParsedDiskMessage[] {
  const out: ParsedDiskMessage[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.isSidechain === true || obj.isMeta === true) continue;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg =
      obj.message && typeof obj.message === 'object'
        ? (obj.message as Record<string, unknown>)
        : undefined;
    const rawText = extractTextBlocks(msg?.content ?? obj.content);
    const clean = stripOrkestraContext(rawText);
    if (!clean || (obj.type === 'user' && isBoilerplateMessage(clean))) continue;
    const ts = parseTimestampMs(obj.timestamp, fallbackTs);
    out.push({
      itemId: typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : `claude-${obj.type}-${i}`,
      role: obj.type,
      content: clean,
      createdAt: ts,
    });
  }
  return out;
}

function parseCodexMessages(raw: string, fallbackTs: number): ParsedDiskMessage[] {
  const out: ParsedDiskMessage[] = [];
  const seenKey = new Set<string>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload =
      obj.payload && typeof obj.payload === 'object'
        ? (obj.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;

    let role: 'user' | 'assistant' | null = null;
    let rawText = '';
    if (obj.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        role = 'user';
        rawText = payload.message;
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
        role = 'assistant';
        rawText = payload.message;
      }
    } else if (
      obj.type === 'response_item' &&
      (payload.role === 'user' || payload.role === 'assistant')
    ) {
      role = payload.role;
      rawText = extractTextBlocks(payload.content);
    }

    if (!role) continue;
    const clean = stripOrkestraContext(rawText);
    if (!clean || (role === 'user' && isBoilerplateMessage(clean))) continue;
    const dedup = `${role}:${clean}`;
    if (seenKey.has(dedup)) continue;
    seenKey.add(dedup);

    const ts = parseTimestampMs(obj.timestamp, fallbackTs);
    out.push({
      itemId: typeof payload.id === 'string' && payload.id ? payload.id : `codex-${role}-${i}`,
      role,
      content: clean,
      createdAt: ts,
    });
  }
  return out;
}

async function readTranscriptSafe(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > MAX_TRANSCRIPT_BYTES) return null;
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function indexClaudeSessionFiles(home: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const root = join(home, '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return map;
  }

  for (const dir of projectDirs) {
    if (dir.startsWith('ssh-')) continue;
    const dirPath = join(root, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;
      const sessionId = basename(file, '.jsonl');
      if (!map.has(sessionId)) {
        map.set(sessionId, join(dirPath, file));
      }
    }
  }
  return map;
}

async function indexCodexSessionFiles(
  home: string,
  targetIds: Set<string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (targetIds.size === 0) return map;
  const root = join(home, '.codex', 'sessions');

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || map.size >= targetIds.size) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (map.size >= targetIds.size) break;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl')
      ) {
        const matchedByName = [...targetIds].find((id) => entry.name.includes(id));
        if (matchedByName) {
          map.set(matchedByName, fullPath);
          continue;
        }
        const content = await readTranscriptSafe(fullPath);
        if (!content) continue;
        const firstNewline = content.indexOf('\n');
        const headLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
        try {
          const obj = JSON.parse(headLine) as {
            type?: unknown;
            payload?: { id?: unknown; session_id?: unknown };
          };
          if (obj.type === 'session_meta' && obj.payload) {
            const sid =
              typeof obj.payload.id === 'string'
                ? obj.payload.id
                : typeof obj.payload.session_id === 'string'
                  ? obj.payload.session_id
                  : '';
            if (sid && targetIds.has(sid)) {
              map.set(sid, fullPath);
            }
          }
        } catch {
          // bozuk satırı atla
        }
      }
    }
  }

  await walk(root, 0);
  return map;
}

export type SearchServiceDeps = {
  db: AppDb;
  sqlite: Database.Database;
  acquireWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntimeAccess | null>;
  searchFileSearchRoot(
    client: HostRuntimesClient['fileSearch'],
    root: HostFileRef,
    query: string,
    limit?: number
  ): Promise<WorkspaceFileHit[]>;
  getSearchExclusions(): Promise<readonly string[]>;
  tasks: Pick<TaskService, 'on'>;
  homeDir?: string;
};

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  initialize(): void {
    this.deps.tasks.on('task:created', (task) => void this.upsertTaskWithBranch(task));
    this.deps.tasks.on('task:updated', (task) => void this.upsertTaskWithBranch(task));
    this.deps.tasks.on('task:archived', (taskId) => this.removeByType('task', taskId));
    this.deps.tasks.on('task:deleted', (taskId) => this.removeByType('task', taskId));

    projectEvents.on('project:created', (project) => this.upsertProject(project));
    projectEvents.on('project:renamed', (projectId, name) => this.renameProject(projectId, name));
    projectEvents.on('project:deleted', (projectId) => this.removeProject(projectId));

    conversationEvents.on('conversation:created', (conversation) =>
      this.upsertConversation(conversation)
    );
    conversationEvents.on('conversation:renamed', (conversationId, projectId, taskId, newTitle) => {
      this.upsertConversationById(conversationId, projectId, taskId, newTitle);
      this.renameConversationMessages(conversationId, newTitle);
    });
    conversationEvents.on('conversation:deleted', (conversationId) => {
      this.removeByType('conversation', conversationId);
      this.removeConversationMessages(conversationId);
    });

    this.backfill();

    if (this.hasMessageSearchTable()) {
      try {
        const countRow = this.deps.sqlite
          .prepare(`SELECT count(*) as n FROM message_search_fts`)
          .get() as { n: number } | undefined;
        if ((countRow?.n ?? 0) === 0) {
          void Promise.resolve()
            .then(() => this.backfillMessagesFromDisk())
            .catch((error) => {
              log.warn('SearchService: message disk backfill failed', { error: String(error) });
            });
        }
      } catch (error) {
        log.warn('SearchService: message index count check failed', { error: String(error) });
      }
    }
  }

  async searchFiles(
    workspaceId: string,
    query: string,
    limit?: number
  ): Promise<WorkspaceFileHit[]> {
    const workspace = await this.deps.acquireWorkspaceRuntime(workspaceId);
    if (!workspace) return [];
    return await this.deps.searchFileSearchRoot(
      workspace.client.fileSearch,
      hostFileRef(workspace.identity.host, workspace.files.root),
      query,
      limit
    );
  }

  async searchContent(
    input: JobInput<typeof searchContract.searchWorkspaceContent>,
    context: LiveJobContext<JobProgress<typeof searchContract.searchWorkspaceContent>>
  ): Promise<
    Result<
      JobResult<typeof searchContract.searchWorkspaceContent>,
      JobError<typeof searchContract.searchWorkspaceContent>
    >
  > {
    let workspace: WorkspaceRuntimeAccess | null;
    try {
      workspace = await this.deps.acquireWorkspaceRuntime(input.workspaceId);
    } catch (error) {
      if (isRuntimeResolveError(error)) return err(error);
      throw error;
    }
    if (!workspace) {
      return err({
        type: 'workspace-not-found',
        workspaceId: input.workspaceId,
        message: `Workspace was not found: ${input.workspaceId}`,
      });
    }

    const jobs = createLiveJobReplicaCache(
      contentSearchRuntimeContract.searchContent,
      workspace.client.fileSearch.searchContent
    );
    const { workspaceId: _, ...searchInput } = input;
    try {
      const lease = await jobs.start({
        ...searchInput,
        root: workspace.files.root,
        exclusions: [...(await this.deps.getSearchExclusions())],
      });
      try {
        const job = await lease.ready();
        const unsubscribe = job.onProgress(context.progress);
        const cancel = () => void job.cancel();
        context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
        try {
          return ok(await job.result);
        } catch (error) {
          if (error instanceof LiveJobFailedError) return err(error.error);
          throw error;
        } finally {
          context.signal.removeEventListener('abort', cancel);
          unsubscribe();
        }
      } finally {
        await lease.release();
      }
    } finally {
      await jobs.dispose();
    }
  }

  async searchEntities({
    kind,
    query,
    context,
    limit = 50,
  }: PaletteEntitySearchQuery): Promise<SearchItem[]> {
    const trimmed = query.trim();
    const resultLimit = Math.max(1, Math.min(limit, 100));
    if (!trimmed) {
      return this.recents(context)
        .filter((item) => item.kind === kind)
        .slice(0, resultLimit);
    }
    const taskId = context?.taskId;

    try {
      const escaped = escapeLike(trimmed);
      const prefixPattern = `${escaped}%`;
      const substringPattern = `%${escaped}%`;
      const fuzzyPattern = `%${Array.from(trimmed).map(escapeLike).join('%')}%`;
      const rows = (
        kind === 'conversation' && taskId
          ? this.deps.sqlite
              .prepare(
                `SELECT item_type, item_id, project_id, task_id, title, keywords, 0 AS rank
                 FROM search_index
                 WHERE item_type = ? AND task_id = ?
                   AND (title LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')
                 ORDER BY CASE
                   WHEN lower(title) = lower(?) THEN 0
                   WHEN title LIKE ? ESCAPE '\\' THEN 1
                   WHEN title LIKE ? ESCAPE '\\' THEN 2
                   ELSE 3
                 END, length(title), title
                 LIMIT ?`
              )
              .all(
                kind,
                taskId,
                fuzzyPattern,
                fuzzyPattern,
                trimmed,
                prefixPattern,
                substringPattern,
                resultLimit
              )
          : this.deps.sqlite
              .prepare(
                `SELECT item_type, item_id, project_id, task_id, title, keywords, 0 AS rank
                 FROM search_index
                 WHERE item_type = ?
                   AND (title LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')
                 ORDER BY CASE
                   WHEN lower(title) = lower(?) THEN 0
                   WHEN title LIKE ? ESCAPE '\\' THEN 1
                   WHEN title LIKE ? ESCAPE '\\' THEN 2
                   ELSE 3
                 END, length(title), title
                 LIMIT ?`
              )
              .all(
                kind,
                fuzzyPattern,
                fuzzyPattern,
                trimmed,
                prefixPattern,
                substringPattern,
                resultLimit
              )
      ) as FtsRow[];

      return rows.map((row) => ({
        kind,
        id: row.item_id,
        projectId: row.project_id,
        taskId: row.task_id,
        title: row.title,
        subtitle: row.keywords ?? '',
        score: row.rank,
      }));
    } catch (error) {
      log.warn('SearchService: palette entity query failed', {
        kind,
        query,
        error: String(error),
      });
      return [];
    }
  }

  private resolveConversationTitle(conversationId: string, explicitTitle?: string): string {
    const trimmed = explicitTitle?.trim();
    if (trimmed) return trimmed;
    try {
      const row = this.deps.sqlite
        .prepare(`SELECT title FROM conversations WHERE id = ?`)
        .get(conversationId) as { title?: string } | undefined;
      return row?.title?.trim() || 'Sohbet';
    } catch {
      return 'Sohbet';
    }
  }

  indexConversationMessages(input: IndexConversationMessagesInput): void {
    if (!input.conversationId || !this.hasMessageSearchTable()) return;

    const preparedMessages: Array<{
      itemId: string;
      role: string;
      content: string;
      createdAt: number;
    }> = [];
    const fallbackNow = Date.now();
    for (const msg of input.messages) {
      const cleaned = stripOrkestraContext(msg.content);
      if (!cleaned) continue;
      preparedMessages.push({
        itemId: msg.itemId,
        role: msg.role,
        content: cleaned,
        createdAt: msg.createdAt ?? fallbackNow,
      });
    }

    const title = this.resolveConversationTitle(input.conversationId, input.conversationTitle);

    try {
      this.deps.sqlite.transaction(() => {
        this.deps.sqlite
          .prepare(`DELETE FROM message_search_fts WHERE conversation_id = ?`)
          .run(input.conversationId);

        if (preparedMessages.length === 0) return;

        const insertStmt = this.deps.sqlite.prepare(
          `INSERT INTO message_search_fts(
             conversation_id,
             project_id,
             task_id,
             item_id,
             role,
             conversation_title,
             content,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const msg of preparedMessages) {
          insertStmt.run(
            input.conversationId,
            input.projectId,
            input.taskId,
            msg.itemId,
            msg.role,
            title,
            msg.content,
            msg.createdAt
          );
        }
      })();
    } catch (error) {
      log.warn('SearchService: indexConversationMessages failed', {
        conversationId: input.conversationId,
        error: String(error),
      });
    }
  }

  appendConversationMessage(input: {
    conversationId: string;
    projectId: string;
    taskId: string;
    conversationTitle?: string;
    message: { itemId: string; role: string; content: string; createdAt?: number };
  }): void {
    if (!input.conversationId || !input.message.itemId || !this.hasMessageSearchTable()) return;
    const cleaned = stripOrkestraContext(input.message.content);
    if (!cleaned) return;
    const title = this.resolveConversationTitle(input.conversationId, input.conversationTitle);
    const createdAt = input.message.createdAt ?? Date.now();

    try {
      this.deps.sqlite.transaction(() => {
        this.deps.sqlite
          .prepare(`DELETE FROM message_search_fts WHERE conversation_id = ? AND item_id = ?`)
          .run(input.conversationId, input.message.itemId);
        this.deps.sqlite
          .prepare(
            `INSERT INTO message_search_fts(
               conversation_id,
               project_id,
               task_id,
               item_id,
               role,
               conversation_title,
               content,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.conversationId,
            input.projectId,
            input.taskId,
            input.message.itemId,
            input.message.role,
            title,
            cleaned,
            createdAt
          );
      })();
    } catch (error) {
      log.warn('SearchService: appendConversationMessage failed', {
        conversationId: input.conversationId,
        error: String(error),
      });
    }
  }

  removeConversationMessages(conversationId: string): void {
    if (!conversationId || !this.hasMessageSearchTable()) return;
    try {
      this.deps.sqlite
        .prepare(`DELETE FROM message_search_fts WHERE conversation_id = ?`)
        .run(conversationId);
    } catch (error) {
      log.warn('SearchService: removeConversationMessages failed', {
        conversationId,
        error: String(error),
      });
    }
  }

  searchMessages(query: MessageSearchQuery): MessageSearchHit[] {
    const trimmed = query.query.trim();
    if (!trimmed || !this.hasMessageSearchTable()) return [];

    const limit = Math.max(1, Math.min(query.limit ?? 30, 100));
    const rawTokens = trimmed.split(/\s+/).filter(Boolean);
    if (rawTokens.length === 0) return [];

    const ftsTokens = rawTokens.filter((token) => token.length >= 3);
    const shortTokens = rawTokens.filter((token) => token.length < 3);

    const scopeClauses: string[] = [];
    const scopeParams: string[] = [];
    if (query.projectId) {
      scopeClauses.push(`project_id = ?`);
      scopeParams.push(query.projectId);
    }
    if (query.taskId) {
      scopeClauses.push(`task_id = ?`);
      scopeParams.push(query.taskId);
    }

    if (ftsTokens.length > 0) {
      try {
        const matchExpr = ftsTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
        const whereClauses: string[] = [`message_search_fts MATCH ?`, ...scopeClauses];
        const params: Array<string | number> = [matchExpr, ...scopeParams];

        for (const token of shortTokens) {
          const pattern = `%${escapeLike(token)}%`;
          whereClauses.push(`(content LIKE ? ESCAPE '\\' OR conversation_title LIKE ? ESCAPE '\\')`);
          params.push(pattern, pattern);
        }

        params.push(limit);
        const rows = this.deps.sqlite
          .prepare(
            `SELECT
               conversation_id,
               project_id,
               task_id,
               item_id,
               role,
               conversation_title,
               content,
               snippet(message_search_fts, 6, '<mark>', '</mark>', '...', 48) AS snippet,
               bm25(message_search_fts, 0, 0, 0, 0, 0, 0.5, 1.0, 0) AS rank
             FROM message_search_fts
             WHERE ${whereClauses.join(' AND ')}
             ORDER BY rank ASC, created_at DESC
             LIMIT ?`
          )
          .all(...params) as MessageFtsRow[];

        return rows.map((row) => {
          const snippetText = row.snippet ?? '';
          const highlighted = snippetText.includes('<mark>')
            ? snippetText
            : buildHighlightedSnippet(row.content, rawTokens);
          const rawScore = typeof row.rank === 'number' && Number.isFinite(row.rank) ? -row.rank : 1;
          return {
            conversationId: row.conversation_id,
            projectId: row.project_id,
            taskId: row.task_id,
            itemId: row.item_id,
            role: row.role,
            conversationTitle: row.conversation_title,
            snippet: highlighted,
            score: Math.max(0.0001, rawScore),
          };
        });
      } catch (error) {
        log.warn('SearchService: FTS message query failed, falling back to LIKE', {
          query: trimmed,
          error: String(error),
        });
      }
    }

    try {
      const whereClauses: string[] = [...scopeClauses];
      const params: Array<string | number> = [...scopeParams];

      for (const token of rawTokens) {
        const pattern = `%${escapeLike(token)}%`;
        whereClauses.push(`(content LIKE ? ESCAPE '\\' OR conversation_title LIKE ? ESCAPE '\\')`);
        params.push(pattern, pattern);
      }

      const fullPattern = `%${escapeLike(trimmed)}%`;
      params.push(fullPattern, limit);

      const rows = this.deps.sqlite
        .prepare(
          `SELECT
             conversation_id,
             project_id,
             task_id,
             item_id,
             role,
             conversation_title,
             content
           FROM message_search_fts
           WHERE ${whereClauses.join(' AND ')}
           ORDER BY
             CASE WHEN content LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
             created_at DESC
           LIMIT ?`
        )
        .all(...params) as MessageFtsRow[];

      return rows.map((row) => ({
        conversationId: row.conversation_id,
        projectId: row.project_id,
        taskId: row.task_id,
        itemId: row.item_id,
        role: row.role,
        conversationTitle: row.conversation_title,
        snippet: buildHighlightedSnippet(row.content, rawTokens),
        score: 1,
      }));
    } catch (error) {
      log.warn('SearchService: LIKE message fallback query failed', {
        query: trimmed,
        error: String(error),
      });
      return [];
    }
  }

  async backfillMessagesFromDisk(): Promise<void> {
    if (!this.hasMessageSearchTable() || typeof this.deps.db?.select !== 'function') return;

    try {
      const existingCount = (
        this.deps.sqlite.prepare(`SELECT count(*) as n FROM message_search_fts`).get() as
          | { n: number }
          | undefined
      )?.n;
      if ((existingCount ?? 0) > 0) return;

      const rows = this.deps.db
        .select({
          id: conversations.id,
          projectId: conversations.projectId,
          taskId: conversations.taskId,
          title: conversations.title,
          provider: conversations.provider,
          providerSessionId: conversations.providerSessionId,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .innerJoin(tasks, and(eq(conversations.taskId, tasks.id), isNull(tasks.deletedAt)))
        .where(and(isNull(conversations.untrackedAt), isNotNull(conversations.providerSessionId)))
        .all();

      if (rows.length === 0) return;

      const home = this.deps.homeDir ?? homedir();
      const hasClaude = rows.some((r) => r.provider === 'claude');
      const codexIds = new Set<string>(
        rows
          .filter(
            (r) =>
              r.provider === 'codex' &&
              r.providerSessionId &&
              SAFE_SESSION_ID_RE.test(r.providerSessionId)
          )
          .map((r) => r.providerSessionId!)
      );

      const [claudeFiles, codexFiles] = await Promise.all([
        hasClaude ? indexClaudeSessionFiles(home) : Promise.resolve(new Map<string, string>()),
        codexIds.size > 0
          ? indexCodexSessionFiles(home, codexIds)
          : Promise.resolve(new Map<string, string>()),
      ]);

      const checkStmt = this.deps.sqlite.prepare(
        `SELECT 1 FROM message_search_fts WHERE conversation_id = ? LIMIT 1`
      );
      let indexedConversations = 0;

      for (const row of rows) {
        if (!row.projectId || !row.taskId || !row.providerSessionId) continue;
        if (!SAFE_SESSION_ID_RE.test(row.providerSessionId)) continue;
        if (checkStmt.get(row.id)) continue;

        const fallbackTs = parseTimestampMs(row.createdAt, Date.now());
        let messages: ParsedDiskMessage[] = [];

        if (row.provider === 'antigravity') {
          const transcriptPath = join(
            home,
            '.gemini',
            'antigravity',
            'brain',
            row.providerSessionId,
            '.system_generated',
            'logs',
            'transcript.jsonl'
          );
          const raw = await readTranscriptSafe(transcriptPath);
          if (raw) messages = parseAntigravityMessages(raw, fallbackTs);
        } else if (row.provider === 'claude') {
          const filePath = claudeFiles.get(row.providerSessionId);
          if (filePath) {
            const raw = await readTranscriptSafe(filePath);
            if (raw) messages = parseClaudeMessages(raw, fallbackTs);
          }
        } else if (row.provider === 'codex') {
          const filePath = codexFiles.get(row.providerSessionId);
          if (filePath) {
            const raw = await readTranscriptSafe(filePath);
            if (raw) messages = parseCodexMessages(raw, fallbackTs);
          }
        }

        if (messages.length > 0 && !checkStmt.get(row.id)) {
          this.indexConversationMessages({
            conversationId: row.id,
            projectId: row.projectId,
            taskId: row.taskId,
            conversationTitle: row.title,
            messages,
          });
          indexedConversations += 1;
        }
      }

      if (indexedConversations > 0) {
        log.info('SearchService: backfilled conversation messages from disk', {
          conversations: indexedConversations,
        });
      }
    } catch (error) {
      log.warn('SearchService: backfillMessagesFromDisk failed', { error: String(error) });
    }
  }

  private hasMessageSearchTable(): boolean {
    try {
      const row = this.deps.sqlite
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_search_fts' LIMIT 1`
        )
        .get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private renameConversationMessages(conversationId: string, newTitle: string): void {
    if (!conversationId || !this.hasMessageSearchTable()) return;
    try {
      this.deps.sqlite
        .prepare(`UPDATE message_search_fts SET conversation_title = ? WHERE conversation_id = ?`)
        .run(newTitle, conversationId);
    } catch (error) {
      log.warn('SearchService: renameConversationMessages failed', {
        conversationId,
        error: String(error),
      });
    }
  }

  private recents(context?: PaletteEntitySearchQuery['context']): SearchItem[] {
    const taskStmt = context?.projectId
      ? this.deps.sqlite.prepare(
          `SELECT t.id, t.name, t.project_id
           FROM tasks t
           WHERE t.archived_at IS NULL AND t.deleted_at IS NULL AND t.project_id = ?
           ORDER BY t.last_interacted_at DESC
           LIMIT 10`
        )
      : this.deps.sqlite.prepare(
          `SELECT t.id, t.name, t.project_id
           FROM tasks t
           WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
           ORDER BY t.last_interacted_at DESC
           LIMIT 10`
        );

    const taskRows = (
      context?.projectId ? taskStmt.all(context.projectId) : taskStmt.all()
    ) as RecentTaskRow[];

    const results: SearchItem[] = taskRows.map((r) => ({
      kind: 'task' as const,
      id: r.id,
      projectId: r.project_id,
      taskId: null,
      title: r.name,
      subtitle: '',
      score: 0,
    }));

    const conversationRows = (
      context?.taskId
        ? this.deps.sqlite
            .prepare(
              `SELECT c.id, c.title, c.project_id, c.task_id
               FROM conversations c
               INNER JOIN tasks t ON t.id = c.task_id
               WHERE t.deleted_at IS NULL
                 AND c.untracked_at IS NULL
                 AND c.project_id IS NOT NULL
                 AND c.task_id IS NOT NULL
               ORDER BY CASE WHEN c.task_id = ? THEN 0 ELSE 1 END,
                 c.last_session_activity_at DESC
               LIMIT 10`
            )
            .all(context.taskId)
        : this.deps.sqlite
            .prepare(
              `SELECT c.id, c.title, c.project_id, c.task_id
               FROM conversations c
               INNER JOIN tasks t ON t.id = c.task_id
               WHERE t.deleted_at IS NULL
                 AND c.untracked_at IS NULL
                 AND c.project_id IS NOT NULL
                 AND c.task_id IS NOT NULL
               ORDER BY c.last_session_activity_at DESC
               LIMIT 10`
            )
            .all()
    ) as RecentConversationRow[];

    for (const r of conversationRows) {
      results.push({
        kind: 'conversation',
        id: r.id,
        projectId: r.project_id,
        taskId: r.task_id,
        title: r.title,
        subtitle: '',
        score: 0,
      });
    }

    return results;
  }

  private async upsertTaskWithBranch(task: Task): Promise<void> {
    let branchName: string | undefined;
    if (task.workspaceId) {
      const [ws] = await this.deps.db
        .select({ kind: workspaces.kind, config: workspaces.config })
        .from(workspaces)
        .where(and(eq(workspaces.id, task.workspaceId), liveWorkspaces()))
        .limit(1);
      branchName = ws ? (getProvisionedWorkspaceBranch(ws) ?? undefined) : undefined;
    }
    this.upsertTask(task, branchName);
  }

  private upsertTask(task: Task, branchName?: string): void {
    const keywords = [branchName, task.linkedIssue?.identifier, task.linkedIssue?.title]
      .filter(Boolean)
      .join(' ');

    try {
      this.upsertIndexRow('task', task.id, task.projectId, null, task.name, keywords);
    } catch (e) {
      log.warn('SearchService: upsertTask failed', { taskId: task.id, error: String(e) });
    }
  }

  private upsertProject(project: Project): void {
    try {
      this.upsertIndexRow('project', project.id, null, null, project.name, project.path);
    } catch (e) {
      log.warn('SearchService: upsertProject failed', {
        projectId: project.id,
        error: String(e),
      });
    }
  }

  private renameProject(projectId: string, name: string): void {
    try {
      this.deps.sqlite
        .prepare(`UPDATE search_index SET title = ? WHERE item_type = 'project' AND item_id = ?`)
        .run(name, projectId);
    } catch (e) {
      log.warn('SearchService: renameProject failed', { projectId, error: String(e) });
    }
  }

  private upsertConversation(conversation: Conversation): void {
    this.upsertConversationById(
      conversation.id,
      conversation.projectId,
      conversation.taskId,
      conversation.title
    );
  }

  private upsertConversationById(
    conversationId: string,
    projectId: string,
    taskId: string,
    title: string
  ): void {
    try {
      this.upsertIndexRow('conversation', conversationId, projectId, taskId, title, '');
    } catch (e) {
      log.warn('SearchService: upsertConversationById failed', {
        conversationId,
        error: String(e),
      });
    }
  }

  private upsertIndexRow(
    itemType: 'task' | 'project' | 'conversation',
    itemId: string,
    projectId: string | null,
    taskId: string | null,
    title: string,
    keywords: string
  ): void {
    // FTS5 has no uniqueness constraint on entity identity. Replace all prior rows
    // atomically so a failed insert cannot remove the last searchable version.
    this.deps.sqlite.transaction(() => {
      this.deps.sqlite
        .prepare(`DELETE FROM search_index WHERE item_type = ? AND item_id = ?`)
        .run(itemType, itemId);
      this.deps.sqlite
        .prepare(
          `INSERT INTO search_index(item_type, item_id, project_id, task_id, title, keywords)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(itemType, itemId, projectId, taskId, title, keywords);
    })();
  }

  private removeProject(projectId: string): void {
    try {
      // Project deletion cascades without emitting individual task or conversation events.
      this.deps.sqlite
        .prepare(
          `DELETE FROM search_index
           WHERE (item_type = 'project' AND item_id = ?) OR project_id = ?`
        )
        .run(projectId, projectId);
      if (this.hasMessageSearchTable()) {
        this.deps.sqlite
          .prepare(`DELETE FROM message_search_fts WHERE project_id = ?`)
          .run(projectId);
      }
    } catch (e) {
      log.warn('SearchService: removeProject failed', { projectId, error: String(e) });
    }
  }

  private removeByType(itemType: string, itemId: string): void {
    try {
      this.deps.sqlite
        .prepare(`DELETE FROM search_index WHERE item_id = ? AND item_type = ?`)
        .run(itemId, itemType);
    } catch (e) {
      log.warn('SearchService: removeByType failed', { itemType, itemId, error: String(e) });
    }
  }

  private backfill(): void {
    try {
      const count = (
        this.deps.sqlite.prepare(`SELECT count(*) as n FROM search_index`).get() as { n: number }
      ).n;

      if (count > 0) return;

      const allTasks = this.deps.db
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          name: tasks.name,
          archivedAt: tasks.archivedAt,
          linkedIssue: tasks.linkedIssue,
          workspaceKind: workspaces.kind,
          workspaceConfig: workspaces.config,
        })
        .from(tasks)
        .leftJoin(workspaces, and(eq(tasks.workspaceId, workspaces.id), liveWorkspaces()))
        .where(isNull(tasks.deletedAt))
        .all();
      const allProjects = this.deps.db
        .select({ id: projects.id, name: projects.name, path: workspaces.path })
        .from(projects)
        .leftJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
        .where(isNull(projects.deletedAt))
        .all();
      const allConversations = this.deps.db
        .select({
          id: conversations.id,
          projectId: conversations.projectId,
          taskId: conversations.taskId,
          title: conversations.title,
        })
        .from(conversations)
        .innerJoin(tasks, and(eq(conversations.taskId, tasks.id), isNull(tasks.deletedAt)))
        .where(isNull(conversations.untrackedAt))
        .all();

      const upsertStmt = this.deps.sqlite.prepare(
        `INSERT INTO search_index(item_type, item_id, project_id, task_id, title, keywords)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      this.deps.sqlite.transaction(() => {
        for (const t of allTasks) {
          if (t.archivedAt) continue;
          const branchName = getProvisionedWorkspaceBranch({
            kind: t.workspaceKind,
            config: t.workspaceConfig,
          });
          const keywords = [branchName, t.linkedIssue?.identifier, t.linkedIssue?.title]
            .filter(Boolean)
            .join(' ');
          upsertStmt.run('task', t.id, t.projectId, null, t.name, keywords);
        }
        for (const p of allProjects) {
          upsertStmt.run('project', p.id, null, null, p.name, p.path ?? '');
        }
        for (const c of allConversations) {
          upsertStmt.run('conversation', c.id, c.projectId, c.taskId, c.title, '');
        }
      })();

      log.info('SearchService: backfilled search index', {
        tasks: allTasks.filter((t) => !t.archivedAt).length,
        projects: allProjects.length,
        conversations: allConversations.length,
      });
    } catch (e) {
      log.warn('SearchService: backfill failed', { error: String(e) });
    }
  }
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  return new SearchService(deps);
}
