import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isNotNull } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type {
  ExternalSessionProviderId,
  ExternalSessionSummary,
} from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';

const MAX_FILES_PER_PROVIDER = 40;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 90;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  '[Request interrupted',
  'Sen bir işçisin.',
];

async function existingLocalDir(dir: string | null): Promise<string | null> {
  if (!dir || !dir.trim()) return null;
  const trimmed = dir.trim();
  try {
    const info = await stat(trimmed);
    return info.isDirectory() ? trimmed : null;
  } catch {
    return null;
  }
}

async function readHeadText(filePath: string, maxBytes = MAX_HEAD_BYTES): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function cleanTitle(raw: string): string {
  const withoutTags = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!withoutTags) return '';
  if (withoutTags.length <= MAX_TITLE_LENGTH) return withoutTags;
  return `${withoutTags.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}

function isBoilerplateText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return BOILERPLATE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function projectLabelFromCwd(cwd: string | null, providerId: ExternalSessionProviderId): string {
  if (cwd && cwd.trim()) {
    const base = basename(cwd.trim());
    if (base) return base;
  }
  switch (providerId) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'antigravity':
      return 'Antigravity';
    case 'gemini':
      return 'Gemini CLI';
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if (
      (block.type === 'text' || block.type === 'input_text') &&
      typeof block.text === 'string' &&
      !isBoilerplateText(block.text)
    ) {
      return block.text;
    }
  }
  return '';
}

async function scanClaudeSessions(homeDir: string): Promise<ExternalSessionSummary[]> {
  const root = join(homeDir, '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
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
      const filePath = join(dirPath, file);
      const info = await stat(filePath).catch(() => null);
      if (info?.isFile()) candidates.push({ filePath, mtimeMs: info.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, MAX_FILES_PER_PROVIDER);

  const results = await Promise.all(
    top.map(async ({ filePath, mtimeMs }): Promise<ExternalSessionSummary | null> => {
      const head = await readHeadText(filePath);
      if (!head) return null;
      let sessionId = basename(filePath, '.jsonl');
      let cwd: string | null = null;
      let model: string | null = null;
      let firstUserPrompt = '';
      let isSidechain = false;

      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.isSidechain === true) isSidechain = true;
        if (typeof obj.sessionId === 'string' && obj.sessionId) sessionId = obj.sessionId;
        if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;

        if (!firstUserPrompt && obj.type === 'user' && obj.isMeta !== true) {
          const msg = obj.message as Record<string, unknown> | undefined;
          const text = extractTextFromContent(msg?.content ?? obj.content);
          if (text && !isBoilerplateText(text)) {
            firstUserPrompt = text;
          }
        }
        if (!model && obj.type === 'assistant') {
          const msg = obj.message as Record<string, unknown> | undefined;
          if (typeof msg?.model === 'string' && msg.model) model = msg.model;
        }
        if (firstUserPrompt && cwd && model) break;
      }

      if (isSidechain) return null;
      const title = cleanTitle(firstUserPrompt);
      if (!title) return null;
      const validCwd = await existingLocalDir(cwd);
      return {
        id: `claude:${sessionId}`,
        providerId: 'claude',
        nativeSessionId: sessionId,
        title,
        cwd: validCwd,
        projectLabel: projectLabelFromCwd(validCwd ?? cwd, 'claude'),
        model,
        updatedAt: Math.round(mtimeMs),
      };
    })
  );

  return results.filter((item): item is ExternalSessionSummary => item !== null);
}

async function scanCodexSessions(homeDir: string): Promise<ExternalSessionSummary[]> {
  const root = join(homeDir, '.codex', 'sessions');
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const info = await stat(fullPath).catch(() => null);
        if (info?.isFile()) candidates.push({ filePath: fullPath, mtimeMs: info.mtimeMs });
      }
    }
  }

  await walk(root, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, MAX_FILES_PER_PROVIDER);

  const results = await Promise.all(
    top.map(async ({ filePath, mtimeMs }): Promise<ExternalSessionSummary | null> => {
      const head = await readHeadText(filePath);
      if (!head) return null;
      let sessionId = '';
      let cwd: string | null = null;
      let model: string | null = null;
      let firstUserPrompt = '';

      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
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

        if (obj.type === 'session_meta') {
          if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
          else if (typeof payload.session_id === 'string' && payload.session_id) {
            sessionId = payload.session_id;
          }
          if (!cwd && typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
        } else if (obj.type === 'turn_context' && !model) {
          if (typeof payload.model === 'string' && payload.model) model = payload.model;
        } else if (!firstUserPrompt && obj.type === 'event_msg' && payload.type === 'user_message') {
          if (typeof payload.message === 'string' && !isBoilerplateText(payload.message)) {
            firstUserPrompt = payload.message;
          }
        } else if (!firstUserPrompt && obj.type === 'response_item' && payload.role === 'user') {
          const text = extractTextFromContent(payload.content);
          if (text && !isBoilerplateText(text)) {
            firstUserPrompt = text;
          }
        }

        if (sessionId && firstUserPrompt && model) break;
      }

      if (!sessionId) return null;
      const title = cleanTitle(firstUserPrompt);
      if (!title) return null;
      const validCwd = await existingLocalDir(cwd);
      return {
        id: `codex:${sessionId}`,
        providerId: 'codex',
        nativeSessionId: sessionId,
        title,
        cwd: validCwd,
        projectLabel: projectLabelFromCwd(validCwd ?? cwd, 'codex'),
        model,
        updatedAt: Math.round(mtimeMs),
      };
    })
  );

  return results.filter((item): item is ExternalSessionSummary => item !== null);
}

async function scanAntigravitySessions(homeDir: string): Promise<ExternalSessionSummary[]> {
  const brainDir = join(homeDir, '.gemini', 'antigravity', 'brain');
  let dirs: string[];
  try {
    dirs = await readdir(brainDir);
  } catch {
    return [];
  }

  const candidates: Array<{ uuid: string; transcriptPath: string; mtimeMs: number }> = [];
  for (const name of dirs) {
    if (!UUID_RE.test(name)) continue;
    const transcriptPath = join(brainDir, name, '.system_generated', 'logs', 'transcript.jsonl');
    const info = await stat(transcriptPath).catch(() => null);
    if (info?.isFile()) {
      candidates.push({ uuid: name, transcriptPath, mtimeMs: info.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, MAX_FILES_PER_PROVIDER);

  const results = await Promise.all(
    top.map(async ({ uuid, transcriptPath, mtimeMs }): Promise<ExternalSessionSummary | null> => {
      const head = await readHeadText(transcriptPath);
      if (!head) return null;
      let firstUserPrompt = '';
      let cwd: string | null = null;

      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type !== 'USER_INPUT' || typeof obj.content !== 'string') continue;
        const content = obj.content;
        const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
        const promptCandidate = reqMatch ? reqMatch[1]! : content;
        if (!firstUserPrompt && !isBoilerplateText(promptCandidate)) {
          firstUserPrompt = promptCandidate;
        }
        if (!cwd) {
          const wsMatch = /Active Workspaces:\s*\n-\s+([^\n]+)/i.exec(content);
          if (wsMatch?.[1]?.trim()) cwd = wsMatch[1].trim();
        }
        if (firstUserPrompt) break;
      }

      const title = cleanTitle(firstUserPrompt);
      if (!title) return null;
      // Antigravity köprü durum dosyası varsa adaptörün sıkı cwd eşleşmesini (s.cwd === p.cwd) koru.
      let stateCwd: string | null = null;
      try {
        const stateRaw = await readFile(
          join(homeDir, '.local', 'state', 'orkestra', 'antigravity', `${uuid}.json`),
          'utf8'
        );
        const parsed = JSON.parse(stateRaw) as { cwd?: unknown };
        if (typeof parsed.cwd === 'string') {
          stateCwd = await existingLocalDir(parsed.cwd);
        }
      } catch {
        stateCwd = null;
      }
      const validCwd = stateCwd ?? (await existingLocalDir(cwd));
      return {
        id: `antigravity:${uuid}`,
        providerId: 'antigravity',
        nativeSessionId: uuid,
        title,
        cwd: validCwd,
        projectLabel: projectLabelFromCwd(validCwd ?? cwd, 'antigravity'),
        model: null,
        updatedAt: Math.round(mtimeMs),
      };
    })
  );

  return results.filter((item): item is ExternalSessionSummary => item !== null);
}

/**
 * Yerel bilgisayardaki desteklenen CLI araçlarının (Claude Code, Codex, Antigravity)
 * geçmiş oturumlarını tarar; hâlihazırda Orkestra'da kayıtlı `providerSessionId`'leri eler.
 */
export async function discoverExternalSessions(
  db: AppDb,
  options?: { limit?: number; homeDir?: string }
): Promise<ExternalSessionSummary[]> {
  const home = options?.homeDir ?? homedir();
  const limit = options?.limit ?? 40;

  const existingRows = await db
    .select({ providerSessionId: conversations.providerSessionId })
    .from(conversations)
    .where(isNotNull(conversations.providerSessionId));

  const knownIds = new Set<string>();
  for (const row of existingRows) {
    if (row.providerSessionId) knownIds.add(row.providerSessionId);
  }

  const [claude, codex, antigravity] = await Promise.all([
    scanClaudeSessions(home),
    scanCodexSessions(home),
    scanAntigravitySessions(home),
  ]);

  const seen = new Set<string>();
  const combined: ExternalSessionSummary[] = [];
  for (const entry of [...claude, ...codex, ...antigravity]) {
    if (knownIds.has(entry.nativeSessionId)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    combined.push(entry);
  }

  combined.sort((a, b) => b.updatedAt - a.updatedAt);
  return combined.slice(0, limit);
}
