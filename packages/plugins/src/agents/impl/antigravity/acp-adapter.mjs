import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_AGY_DIRECTORY =
  process.env.ORKESTRA_AGY_STATE_DIR ||
  join(homedir(), '.local', 'state', 'orkestra', 'antigravity');
const DEFAULT_SUBAGENTS_STATE_DIR =
  process.env.ORKESTRA_SUBAGENTS_DIR || join(homedir(), '.local', 'state', 'orkestra', 'subagents');

export const ORCHESTRATOR_MODELS = [
  {
    value: 'gemini-pro-orchestrator-neon',
    name: 'Orchestrator (Neon)',
    description: 'Antigravity Planlayıcı + Uygulayıcı orkestratör modu (Neon).',
  },
  {
    value: 'gemini-pro-orchestrator',
    name: 'Orchestrator (Carbon)',
    description: 'Antigravity Planlayıcı + Uygulayıcı orkestratör modu (Carbon).',
  },
  {
    value: 'gemini-pro-orchestrator-argon',
    name: 'Orchestrator (Argon)',
    description: 'Antigravity Planlayıcı + Uygulayıcı orkestratör modu (Argon).',
  },
];
const ORCHESTRATOR_MODEL_IDS = new Set(ORCHESTRATOR_MODELS.map((m) => m.value));

export function isOrchestratorModel(modelId) {
  return typeof modelId === 'string' && ORCHESTRATOR_MODEL_IDS.has(modelId.trim());
}

export function collaborationModeForModel(modelId) {
  return isOrchestratorModel(modelId) ? modelId.trim() : 'standard';
}

export function readOrchestratorConfigFromEnv(env = process.env) {
  const rawMode =
    typeof env?.ORKESTRA_AGY_ORCHESTRATOR_MODE === 'string'
      ? env.ORKESTRA_AGY_ORCHESTRATOR_MODE.trim()
      : '';
  const planner =
    typeof env?.ORKESTRA_AGY_ORCHESTRATOR_PLANNER === 'string'
      ? env.ORKESTRA_AGY_ORCHESTRATOR_PLANNER.trim()
      : '';
  const executor =
    typeof env?.ORKESTRA_AGY_ORCHESTRATOR_EXECUTOR === 'string'
      ? env.ORKESTRA_AGY_ORCHESTRATOR_EXECUTOR.trim()
      : '';
  const settings = {};
  if (planner) settings.planner = planner;
  if (executor) settings.executor = executor;
  return {
    defaultMode: isOrchestratorModel(rawMode) ? rawMode : null,
    settings: Object.keys(settings).length > 0 ? settings : null,
  };
}

function normalizeOrchestratorSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const planner = typeof raw.planner === 'string' ? raw.planner.trim() : '';
  const executor = typeof raw.executor === 'string' ? raw.executor.trim() : '';
  const out = {};
  if (planner) out.planner = planner;
  if (executor) out.executor = executor;
  return Object.keys(out).length > 0 ? out : null;
}

function orchestratorKey(raw) {
  const norm = normalizeOrchestratorSettings(raw);
  return norm ? `${norm.planner || ''}|${norm.executor || ''}` : '';
}

export const FALLBACK_MODELS = [
  ['gemini-4-carbon-high', 'Gemini 4 Carbon (Yüksek)'],
  ['gemini-4-carbon-medium', 'Gemini 4 Carbon (Orta)'],
  ['gemini-4-carbon-low', 'Gemini 4 Carbon (Düşük)'],
  ['gemini-4-neon-high', 'Gemini 4 Neon (Yüksek)'],
  ['gemini-4-neon-xhigh', 'Gemini 4 Neon (Çok Yüksek)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Orta)'],
  ['gemini-4-neon-low', 'Gemini 4 Neon (Düşük)'],
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Orta)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (Yüksek)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Düşük)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (Çok Yüksek)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (Yüksek)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Orta)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Düşük)'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (Yüksek)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Orta)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Düşük)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Düşük)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Orta)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (Yüksek)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Düşük)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Orta)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (Yüksek)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Orta)'],
];
const modes = [
  {
    value: 'default',
    name: 'Standart',
    description:
      'Antigravity izin kurallarını korur. Ek onay isteyen araçlar sohbet modunda çalıştırılmaz.',
  },
  { value: 'plan', name: 'Plan', description: 'Antigravity planlama modu.' },
  {
    value: 'auto',
    name: 'Otomatik onay',
    description: 'Araç izinlerini bu oturum için otomatik onaylar.',
  },
];
export function parseModels(text) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const tabParts = trimmed.split(/\t+/);
      return tabParts.length >= 2 ? tabParts : trimmed.split(/\s{2,}/);
    })
    .filter((parts) => parts.length >= 2 && /^[a-z0-9][a-z0-9._-]+$/.test(parts[0]))
    .map(([value, name]) => ({
      value,
      name: name
        .replace('(XHigh)', '(Çok Yüksek)')
        .replace('(Max)', '(En Yüksek)')
        .replace('(High)', '(Yüksek)')
        .replace('(Medium)', '(Orta)')
        .replace('(Low)', '(Düşük)')
        .replace('(Thinking)', '(Düşünen)'),
    }));
}
export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.some((b) => b.type !== 'text'))
    throw new Error('Antigravity sohbeti şu anda yalnızca metin iletilerini destekler.');
  return blocks.map((b) => b.text).join('\n');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Replay limits: a huge conversation must never stall session/load.
export const REPLAY_MAX_BYTES = 5 * 1024 * 1024;
export const REPLAY_MAX_LINES = 2000;
const REPLAY_OUTPUT_LIMIT = 4000;
const HIDDEN_CONTEXT = /<orkestra_context>[\s\S]*?<\/orkestra_context>/g;
const REPLAY_TRUNCATED_NOTE =
  '_Önceki konuşma geçmişi kısaltıldı; yalnızca son adımlar gösteriliyor._\n\n';
// Mirrors core's stripHiddenContext so a replayed prompt reads like the live user message.
export function replayUserText(content) {
  if (typeof content !== 'string') return '';
  const start = content.indexOf('<USER_REQUEST>');
  if (start < 0) return '';
  const from = start + '<USER_REQUEST>'.length,
    end = content.lastIndexOf('</USER_REQUEST>');
  return content
    .slice(from, end >= from ? end : undefined)
    .replace(HIDDEN_CONTEXT, '')
    .trim();
}
function replayOutput(content) {
  if (typeof content !== 'string') return undefined;
  const text = content.replace(/^(?:Created At|Completed At): [^\n]*\n/gm, '').trim();
  if (!text) return undefined;
  return text.length > REPLAY_OUTPUT_LIMIT ? text.slice(0, REPLAY_OUTPUT_LIMIT) + '\n…' : text;
}
// Reads the newest part of the transcript; reports whether older history was left out.
async function readTranscriptTail(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, REPLAY_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let lines = buffer.subarray(0, read).toString('utf8').split('\n');
    let cut = size > length;
    if (cut) lines.shift(); // first line is probably partial
    lines = lines.filter((line) => line.trim());
    if (lines.length > REPLAY_MAX_LINES) {
      lines = lines.slice(-REPLAY_MAX_LINES);
      cut = true;
    }
    return { lines, cut };
  } finally {
    await handle.close();
  }
}
// --- Swarm (native sub-agents) -------------------------------------------------------------
// agy delegates through its own `swarm` tools. `swarm add` becomes an ACP sub-agent row; the
// member's board posts (swarm/board.jsonl) become that row's reply.
export const SWARM_REPLY_MESSAGE_LIMIT = 6000;
export const SWARM_REPLY_LIMIT = 20000;
const SWARM_BRIEF_LIMIT = 4000;
const SWARM_SYNC_TOOLS = new Set(['swarm', 'swarm_wait', 'read_board', 'post_message']);
const SWARM_DONE = /^\S*\s*\[done\]/i;
const SWARM_FAILED = /^\S*\s*\[(?:failed?|error)\]/i;
const SWARM_ENDED_PHASES = new Set(['KILLED', 'DONE', 'FINISHED', 'COMPLETED', 'STOPPED']);
const SWARM_TITLES = {
  swarm_wait: 'Swarm: bekle',
  read_board: 'Swarm: panoyu oku',
  post_message: 'Swarm: mesaj gönder',
};
const SWARM_ACTION_TITLES = {
  status: 'Swarm: durum',
  kill: 'Swarm: sonlandır',
  models: 'Swarm: modeller',
  title: 'Swarm: başlık',
};
const TRUNCATED_MARK = /\n?<truncated \d+ bytes>$/;
const JSON_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
function lenientJsonString(value) {
  const cut = TRUNCATED_MARK.test(value);
  let body = value.slice(1).replace(TRUNCATED_MARK, '');
  if (!cut && body.endsWith('"')) body = body.slice(0, -1);
  body = body.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, ''); // escape cut in half
  const text = body.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, esc) =>
    esc[0] === 'u' && esc.length === 5
      ? String.fromCharCode(parseInt(esc.slice(1), 16))
      : (JSON_ESCAPES[esc] ?? esc)
  );
  return cut ? text + '…' : text;
}
// Transcript args are JSON-encoded strings (`"\"add\""`); live parameters are plain values.
function decodeSwarmArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    let decoded = value;
    if (typeof value === 'string') {
      try {
        decoded = JSON.parse(value);
      } catch {
        // Long values are cut as `"text...\n<truncated N bytes>`, which is no longer valid JSON.
        if (value.startsWith('"')) decoded = lenientJsonString(value);
      }
    }
    out[key] = decoded;
  }
  return out;
}
function swarmDirectory(brainDirectory, nativeId) {
  if (typeof nativeId !== 'string' || !UUID.test(nativeId)) return undefined;
  return join(brainDirectory, nativeId, '.system_generated', 'swarm');
}
// Parses a swarm tool call. `member` is set only for `swarm add`; anything else just gets a
// readable title and stays an ordinary tool row.
export function swarmCall(name, rawArgs, modelName) {
  const args = decodeSwarmArgs(rawArgs);
  const isObject = args && typeof args === 'object' && !Array.isArray(args);
  if (name === 'swarm') {
    const action = isObject ? args.action : undefined;
    if (action === 'add' && typeof args.name === 'string' && args.name.trim()) {
      const member = args.name.trim(),
        brief = typeof args.brief === 'string' ? args.brief.trim() : '';
      const model = typeof args.model === 'string' ? modelName?.(args.model) : undefined;
      return {
        member,
        // The transcript cuts long briefs; the board still holds the full text.
        truncatedBrief: typeof rawArgs?.brief === 'string' && TRUNCATED_MARK.test(rawArgs.brief),
        title: model ? `${member} · ${model}` : member,
        kind: 'subagent',
        rawInput: {
          ...args,
          // `description` is what Orkestra shows as the sub-agent's task.
          ...(brief ? { description: brief.slice(0, SWARM_BRIEF_LIMIT), prompt: brief } : {}),
        },
      };
    }
    const label = SWARM_ACTION_TITLES[action];
    if (label) {
      const target = action === 'kill' && typeof args.name === 'string' ? ` (${args.name})` : '';
      return { title: label + target, kind: 'other', rawInput: args };
    }
  } else if (SWARM_TITLES[name]) {
    return { title: SWARM_TITLES[name], kind: 'other', rawInput: args };
  }
  return undefined;
}
// Output of `swarm add`: `{"status":"added",...,"note":"... board as #17 ..."}` after a header.
export function parseSwarmOutput(output) {
  if (typeof output !== 'string') return undefined;
  try {
    const parsed = JSON.parse(
      output.replace(/^(?:Created At|Completed At): [^\n]*\n/gm, '').trim()
    );
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export function swarmAddFailed(output, error) {
  if (error) return true;
  const parsed = parseSwarmOutput(output);
  return Boolean(parsed && (parsed.error || parsed.status === 'error'));
}
export function swarmBriefSeq(output) {
  const note = parseSwarmOutput(output)?.note;
  const match = typeof note === 'string' ? /#(\d+)/.exec(note) : null;
  return match ? Number(match[1]) : 0;
}
async function readBoard(directory) {
  try {
    const { lines } = await readTranscriptTail(join(directory, 'board.jsonl'));
    const rows = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row.agent === 'string' && typeof row.text === 'string')
          rows.push({
            seq: Number.isFinite(row.seq) ? row.seq : 0,
            agent: row.agent,
            kind: row.kind,
            text: row.text,
          });
      } catch {
        /* skip damaged lines */
      }
    }
    return rows;
  } catch {
    return [];
  }
}
async function readMembers(directory) {
  const members = new Map();
  try {
    const path = join(directory, 'members.json');
    if ((await stat(path)).size > 1024 * 1024) return members;
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    for (const [name, info] of Object.entries(parsed?.members ?? {}))
      if (info && typeof info === 'object') members.set(name, info);
  } catch {
    /* missing or malformed: rows keep their last known state */
  }
  return members;
}
// Keeps the newest posts under the cap; one oversized post is truncated instead of dropped.
function swarmReplyText(posts) {
  const parts = posts.map((text) =>
    text.length > SWARM_REPLY_MESSAGE_LIMIT
      ? text.slice(0, SWARM_REPLY_MESSAGE_LIMIT) + '\n…'
      : text
  );
  let total = 0,
    start = parts.length;
  while (start > 0 && total + parts[start - 1].length <= SWARM_REPLY_LIMIT) {
    start -= 1;
    total += parts[start].length + 2;
  }
  const kept = parts.slice(start).join('\n\n');
  return start > 0 ? '…\n\n' + kept : kept;
}
function pairsToRecord(pairsOrObject) {
  if (!pairsOrObject) return {};
  if (Array.isArray(pairsOrObject)) {
    const out = {};
    for (const item of pairsOrObject) {
      if (item && typeof item.name === 'string' && item.name.trim()) {
        out[item.name] = String(item.value ?? '');
      }
    }
    return out;
  }
  if (typeof pairsOrObject === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(pairsOrObject)) {
      if (typeof k === 'string' && k.trim() && v !== undefined && v !== null) {
        out[k] = String(v);
      }
    }
    return out;
  }
  return {};
}

export function normalizeAcpMcpServers(mcpServers) {
  if (!mcpServers) return {};
  const list = Array.isArray(mcpServers)
    ? mcpServers
    : typeof mcpServers === 'object'
      ? Object.entries(mcpServers).map(([name, cfg]) => ({
          ...(cfg && typeof cfg === 'object' ? cfg : {}),
          name,
        }))
      : [];
  const normalized = {};
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    if (
      (entry.type === 'http' || (!entry.command && typeof entry.url === 'string')) &&
      typeof entry.url === 'string' &&
      entry.url.trim()
    ) {
      const headers = pairsToRecord(entry.headers);
      normalized[name] = {
        url: entry.url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        disabled: entry.disabled === true,
      };
      continue;
    }
    if (typeof entry.command === 'string' && entry.command.trim()) {
      const env = pairsToRecord(entry.env);
      normalized[name] = {
        command: entry.command.trim(),
        args: Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [],
        ...(Object.keys(env).length > 0 ? { env } : {}),
        disabled: entry.disabled === true,
      };
    }
  }
  return normalized;
}

export function filePathFromUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return undefined;
  const trimmed = uri.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function truncateText(value, max = 320) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + '…';
}

function unwrapQuotedString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function formatModelDisplayName(slug) {
  if (typeof slug !== 'string' || !slug.trim()) return undefined;
  const cleaned = slug
    .trim()
    .replace(/^kimi-code\//i, '')
    .replace(/-(low|medium|high|xhigh|max)$/i, '');
  if (/^k3$/i.test(cleaned)) return 'Kimi K3';
  if (/^kimi-for-coding$/i.test(cleaned)) return 'Kimi K2.8 Preview';
  if (/^kimi-for-coding-highspeed$/i.test(cleaned)) return 'Kimi K2.7 Highspeed';
  return cleaned
    .split('-')
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function extractEffortFromModel(slug) {
  if (typeof slug !== 'string') return undefined;
  const match = /-(low|medium|high|xhigh|max)$/i.exec(slug.trim());
  return match ? match[1].toLowerCase() : undefined;
}

function formatSubagentToolTitle(name) {
  const labels = {
    run_command: 'Komut çalıştırılıyor',
    view_file: 'Dosya okunuyor',
    read_file: 'Dosya okunuyor',
    write_to_file: 'Dosya yazılıyor',
    write_file: 'Dosya yazılıyor',
    replace_file_content: 'Dosya düzenleniyor',
    multi_replace_file_content: 'Dosya düzenleniyor',
    edit_file: 'Dosya düzenleniyor',
    grep_search: 'Kodda arama yapılıyor',
    find_by_name: 'Dosya aranıyor',
    list_dir: 'Klasör listeleniyor',
    search_web: 'Web araması yapılıyor',
    send_message: 'Ana ajana rapor gönderildi',
    invoke_subagent: 'Alt ajan başlatılıyor',
  };
  return labels[name] || name || 'Araç çalıştırılıyor';
}

function formatSubagentToolArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  const candidates = [
    args.CommandLine,
    args.command,
    args.Path,
    args.AbsolutePath,
    args.TargetFile,
    args.Query,
    args.query,
    args.DirectoryPath,
    args.SearchPath,
    args.Message,
    args.Prompt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateText(unwrapQuotedString(candidate), 220);
    }
  }
  try {
    const serialized = JSON.stringify(args);
    if (serialized && serialized !== '{}') return truncateText(serialized, 180);
  } catch {
    /* ignore */
  }
  return undefined;
}

function decodeExternalSubagentParams(rawParams) {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return {};
  const out = {};
  for (const [key, val] of Object.entries(rawParams)) {
    out[key] = typeof val === 'string' ? unwrapQuotedString(val) : val;
  }
  return out;
}

function parseJsonObjectLenient(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  let current = raw.trim();
  for (let i = 0; i < 2; i++) {
    if (!current) return null;
    try {
      const parsed = JSON.parse(current);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'string') {
        current = parsed.trim();
        continue;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function extractExternalSubagentCall(u) {
  const toolName = unwrapQuotedString(typeof u?.tool_name === 'string' ? u.tool_name : '');
  const params = u?.tool_info?.parameters;
  if (!params || typeof params !== 'object') return null;
  if (/(?:^|__|[:/])run_subagent$/i.test(toolName)) {
    return decodeExternalSubagentParams(params);
  }
  if (toolName === 'call_mcp_tool') {
    const rawInnerName = params.ToolName ?? params.tool_name ?? params.name;
    const innerName = typeof rawInnerName === 'string' ? unwrapQuotedString(rawInnerName) : '';
    if (innerName && /(?:^|__|[:/])run_subagent$/i.test(innerName)) {
      const innerArgs = params.Arguments ?? params.arguments;
      const parsedObj = parseJsonObjectLenient(innerArgs);
      if (parsedObj) return decodeExternalSubagentParams(parsedObj);
      return {};
    }
  }
  return null;
}

function parseExternalSubagentOutput(rawOutput) {
  if (!rawOutput) return null;
  if (typeof rawOutput === 'object') {
    if (typeof rawOutput.response === 'string' || typeof rawOutput.runId === 'string') {
      return rawOutput;
    }
    if (Array.isArray(rawOutput.content)) {
      for (const item of rawOutput.content) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          const parsed = parseExternalSubagentOutput(item.text);
          if (parsed) return parsed;
        }
      }
    }
    if (typeof rawOutput.text === 'string') {
      return parseExternalSubagentOutput(rawOutput.text);
    }
    return null;
  }
  if (typeof rawOutput === 'string') {
    const trimmed = rawOutput.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end + 1));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

export function parseSubagentTranscript(rawText) {
  const activities = [];
  let status = 'in_progress';
  let summary;
  let modelSlug;
  let lastPlannerStep = null;

  if (typeof rawText !== 'string' || !rawText.trim()) {
    return {
      status,
      summary,
      activities,
      provider: 'antigravity',
      model: undefined,
      effort: undefined,
    };
  }

  const lines = rawText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;
    const stepIndex = step.step_index ?? activities.length;
    const timestamp =
      typeof step.created_at === 'string' ? Date.parse(step.created_at) || undefined : undefined;
    if (typeof step.model === 'string' && step.model.trim()) {
      modelSlug = step.model.trim();
    }

    if (step.status === 'ERROR') {
      activities.push({
        id: `err-${stepIndex}`,
        kind: 'error',
        title: 'Hata oluştu',
        detail: truncateText(step.content || 'Alt ajan bir hatayla karşılaştı.', 280),
        status: 'error',
        ...(timestamp ? { timestamp } : {}),
      });
      status = 'failed';
      summary = truncateText(step.content || 'Alt ajan hata verdi.', 280);
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      lastPlannerStep = step;
      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        activities.push({
          id: `think-${stepIndex}`,
          kind: 'thinking',
          title: 'Düşünüyor',
          detail: truncateText(step.thinking, 260),
          status: step.status === 'DONE' ? 'done' : 'running',
          ...(timestamp ? { timestamp } : {}),
        });
      }
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        step.tool_calls.forEach((tc, tcIdx) => {
          if (!tc || typeof tc !== 'object') return;
          const name = typeof tc.name === 'string' ? tc.name : 'tool';
          if (name === 'send_message') {
            const msg = truncateText(unwrapQuotedString(tc.args?.Message || ''), 320);
            if (msg) summary = msg;
            activities.push({
              id: `msg-send-${stepIndex}-${tcIdx}`,
              kind: 'message',
              title: 'Ana ajana rapor gönderildi',
              ...(msg ? { detail: msg } : {}),
              status: 'done',
              ...(timestamp ? { timestamp } : {}),
            });
          } else {
            const detail = formatSubagentToolArgs(tc.args);
            activities.push({
              id: `tool-${stepIndex}-${tcIdx}`,
              kind: 'tool',
              title: formatSubagentToolTitle(name),
              ...(detail ? { detail } : {}),
              status: step.status === 'DONE' ? 'done' : 'running',
              ...(timestamp ? { timestamp } : {}),
            });
          }
        });
      }
      if (typeof step.content === 'string' && step.content.trim()) {
        const text = truncateText(step.content, 360);
        if (!summary) summary = text;
        activities.push({
          id: `resp-${stepIndex}`,
          kind: 'message',
          title: 'Yanıt',
          detail: text,
          status: step.status === 'DONE' ? 'done' : 'running',
          ...(timestamp ? { timestamp } : {}),
        });
      }
    }
  }

  if (status !== 'failed' && lastPlannerStep) {
    const hasToolCalls =
      Array.isArray(lastPlannerStep.tool_calls) && lastPlannerStep.tool_calls.length > 0;
    if (lastPlannerStep.status === 'DONE' && !hasToolCalls) {
      status = 'completed';
    } else {
      status = 'in_progress';
    }
  }

  const trimmedActivities = activities.length > 40 ? activities.slice(-40) : activities;
  const model = formatModelDisplayName(modelSlug);
  const effort = extractEffortFromModel(modelSlug);
  return {
    status,
    summary,
    activities: trimmedActivities,
    provider: 'antigravity',
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function buildArgs(session) {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    session.model,
  ];
  if (session.nativeId) args.push('--conversation', session.nativeId);
  if (session.mode === 'plan') args.push('--mode', 'plan');
  if (session.mode === 'auto') args.push('--dangerously-skip-permissions');
  const orchestrator = normalizeOrchestratorSettings(session.orchestrator);
  const baseSettings =
    session.settings && typeof session.settings === 'object' && !Array.isArray(session.settings)
      ? { ...session.settings }
      : {};
  if (orchestrator) {
    const existingOrchestrator =
      baseSettings.orchestrator &&
      typeof baseSettings.orchestrator === 'object' &&
      !Array.isArray(baseSettings.orchestrator)
        ? baseSettings.orchestrator
        : {};
    baseSettings.orchestrator = { ...existingOrchestrator, ...orchestrator };
  }
  if (session.mode !== 'auto' && session.mcpServers && typeof session.mcpServers === 'object') {
    const builtinAllows = [];
    if (
      session.mcpServers['orkestra-subagents'] &&
      !session.mcpServers['orkestra-subagents'].disabled
    ) {
      builtinAllows.push(
        'mcp(orkestra-subagents/list_subagent_models)',
        'mcp(orkestra-subagents/run_subagent)'
      );
    }
    if (
      session.mcpServers['orkestra-widgets'] &&
      !session.mcpServers['orkestra-widgets'].disabled
    ) {
      builtinAllows.push('mcp(orkestra-widgets/show_widget)');
    }
    if (builtinAllows.length > 0) {
      const existingPerms =
        baseSettings.permissions &&
        typeof baseSettings.permissions === 'object' &&
        !Array.isArray(baseSettings.permissions)
          ? baseSettings.permissions
          : {};
      const existingAllow = Array.isArray(existingPerms.allow) ? existingPerms.allow : [];
      baseSettings.permissions = {
        ...existingPerms,
        allow: [...new Set([...existingAllow, ...builtinAllows])],
      };
    }
  }
  if (Object.keys(baseSettings).length > 0) {
    args.push('--settings', JSON.stringify(baseSettings));
  }
  return args;
}
export class AntigravityBridge {
  constructor({
    cli = process.env.ORKESTRA_AGY_EXECUTABLE,
    directory = DEFAULT_AGY_DIRECTORY,
    brainDirectory = join(homedir(), '.gemini', 'antigravity-cli', 'brain'),
    mcpConfigPath,
    orchestratorConfig = readOrchestratorConfigFromEnv(process.env),
    notify = () => {},
    spawnProcess = spawn,
    exec = execFile,
  } = {}) {
    this.cli = cli;
    this.directory = directory;
    this.brainDirectory = brainDirectory;
    this.orchestratorConfig = {
      defaultMode: isOrchestratorModel(orchestratorConfig?.defaultMode)
        ? orchestratorConfig.defaultMode
        : null,
      settings: normalizeOrchestratorSettings(orchestratorConfig?.settings),
    };
    this.mcpConfigPath =
      mcpConfigPath ||
      (directory === DEFAULT_AGY_DIRECTORY
        ? process.env.ORKESTRA_AGY_MCP_CONFIG_PATH ||
          join(homedir(), '.gemini', 'config', 'mcp_config.json')
        : join(directory, 'mcp_config.json'));
    this.notify = notify;
    this.spawnProcess = spawnProcess;
    this.exec = exec;
    this.sessions = new Map();
    this.active = new Map();
    this.processes = new Map();
    this.swarms = new Map(); // sessionId -> { members: name -> row state, chain }
    this.models = FALLBACK_MODELS.map(([value, name]) => ({
      value,
      name: name
        .replace('(XHigh)', '(Çok Yüksek)')
        .replace('(Max)', '(En Yüksek)')
        .replace('(High)', '(Yüksek)')
        .replace('(Medium)', '(Orta)')
        .replace('(Low)', '(Düşük)')
        .replace('(Thinking)', '(Düşünen)'),
    }));
  }
  async catalog() {
    try {
      const output = await new Promise((resolve, reject) =>
        this.exec(
          this.cli,
          ['models'],
          { timeout: 20000, maxBuffer: 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        )
      );
      const models = parseModels(output);
      if (models.length) this.models = models;
    } catch {
      /* Keep the last verified catalog when discovery is temporarily unavailable. */
    }
  }
  availableOrchestratorOptions() {
    const byId = new Map(this.models.map((m) => [m.value, m]));
    const available = ORCHESTRATOR_MODELS.filter((entry) => byId.has(entry.value)).map((entry) => ({
      value: entry.value,
      name: byId.get(entry.value)?.name || entry.name,
      description: entry.description,
    }));
    if (available.length === 0) return null;
    return [
      {
        value: 'standard',
        name: 'Standart',
        description: 'Seçili tek model ile doğrudan çalışır.',
      },
      ...available,
    ];
  }
  firstStandardModel() {
    return this.models.find((m) => !isOrchestratorModel(m.value))?.value || this.models[0]?.value;
  }
  options(s) {
    const result = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: s.model,
        options: this.models,
      },
    ];
    const collaborationOptions = this.availableOrchestratorOptions();
    if (collaborationOptions) {
      result.push({
        id: 'collaboration_mode',
        name: 'Çalışma kipi',
        category: 'collaboration_mode',
        type: 'select',
        currentValue: collaborationModeForModel(s.model),
        options: collaborationOptions,
      });
    }
    result.push({
      id: 'mode',
      name: 'İzin kipi',
      category: 'mode',
      type: 'select',
      currentValue: s.mode,
      options: modes,
    });
    return result;
  }
  session(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Antigravity oturumu bulunamadı.');
    return s;
  }
  async save(id, s) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, id + '.json'),
      temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(s), { mode: 0o600 });
    await rename(temp, path);
  }
  async materializeMcpServers(s) {
    const servers = normalizeAcpMcpServers(s?.mcpServers);
    if (Object.keys(servers).length === 0) return;
    try {
      await mkdir(dirname(this.mcpConfigPath), { recursive: true, mode: 0o700 });
      let existingConfig = {};
      try {
        const parsed = JSON.parse(await readFile(this.mcpConfigPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existingConfig = parsed;
        }
      } catch {
        /* Start fresh if config file is missing or unreadable. */
      }
      const existingServers =
        existingConfig.mcpServers &&
        typeof existingConfig.mcpServers === 'object' &&
        !Array.isArray(existingConfig.mcpServers)
          ? existingConfig.mcpServers
          : {};
      const merged = {
        ...existingConfig,
        mcpServers: {
          ...existingServers,
          ...servers,
        },
      };
      const temp = `${this.mcpConfigPath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.mcpConfigPath);
    } catch {
      /* Best-effort MCP config sync. */
    }
  }
  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: 'Orkestra Antigravity', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {} },
        promptCapabilities: { image: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
    };
  }
  readLiveOrchestratorOverride() {
    const configPath = join(this.directory, 'orchestrator-config.json');
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return {
        defaultMode: isOrchestratorModel(raw.defaultMode) ? raw.defaultMode.trim() : null,
        settings: normalizeOrchestratorSettings({
          planner: raw.planner,
          executor: raw.executor,
        }),
      };
    } catch {
      return null;
    }
  }
  refreshOrchestratorConfig() {
    const live = this.readLiveOrchestratorOverride();
    if (!live) return null;
    this.orchestratorConfig = live;
    return live;
  }
  async newSession(p) {
    if (!isAbsolute(p.cwd) || !(await stat(p.cwd)).isDirectory())
      throw new Error('Geçerli bir çalışma klasörü gerekli.');
    await this.catalog();
    this.refreshOrchestratorConfig();
    const id = randomUUID();
    const defaultStandardModel = this.firstStandardModel();
    const configuredDefault =
      this.orchestratorConfig.defaultMode &&
      this.models.some((m) => m.value === this.orchestratorConfig.defaultMode)
        ? this.orchestratorConfig.defaultMode
        : null;
    const s = {
      cwd: p.cwd,
      model: configuredDefault || this.models[0].value,
      ...(defaultStandardModel ? { lastStandardModel: defaultStandardModel } : {}),
      mode: 'default',
      ...(this.orchestratorConfig.settings
        ? { orchestrator: { ...this.orchestratorConfig.settings } }
        : {}),
      ...(p.mcpServers !== undefined ? { mcpServers: normalizeAcpMcpServers(p.mcpServers) } : {}),
    };
    await this.materializeMcpServers(s);
    this.sessions.set(id, s);
    await this.save(id, s);
    return { sessionId: id, configOptions: this.options(s) };
  }
  async loadSession(p) {
    if (!UUID.test(p.sessionId)) throw new Error('Geçersiz oturum kimliği.');
    let s;
    let adoptedFromTui = false;
    try {
      s = JSON.parse(await readFile(join(this.directory, p.sessionId + '.json'), 'utf8'));
      if (s.cwd !== p.cwd) throw new Error('Oturum başka bir çalışma klasörüne ait.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Terminalde başlatılan yerel agy oturumu: köprü dosyası henüz yoksa brain kaydını doğrula.
      if (!isAbsolute(p.cwd) || !(await stat(p.cwd)).isDirectory())
        throw new Error('Geçerli bir çalışma klasörü gerekli.');
      let hasBrain = false;
      try {
        hasBrain = (await stat(join(this.brainDirectory, p.sessionId))).isDirectory();
      } catch {
        hasBrain = false;
      }
      if (!hasBrain) throw new Error('Antigravity oturumu bulunamadı.');
      adoptedFromTui = true;
      await this.catalog();
      s = {
        cwd: p.cwd,
        model: this.models[0].value,
        mode: 'default',
        nativeId: p.sessionId,
      };
    }
    // Permissions are always reselected by the host; never inherit an old bypass.
    s.mode = 'default';
    this.refreshOrchestratorConfig();
    if (this.orchestratorConfig.settings) {
      s.orchestrator = { ...this.orchestratorConfig.settings };
    } else {
      delete s.orchestrator;
    }
    if (p.mcpServers !== undefined) {
      s.mcpServers = normalizeAcpMcpServers(p.mcpServers);
    }
    await this.materializeMcpServers(s);
    if (!adoptedFromTui) await this.catalog();
    this.sessions.set(p.sessionId, s);
    if (adoptedFromTui) await this.save(p.sessionId, s);
    await this.replayHistory(p.sessionId, s.nativeId);
    return { configOptions: this.options(s) };
  }
  // ACP expects history as session/update notifications before session/load resolves.
  // Best effort: a missing or damaged transcript must never fail the load.
  async replayHistory(sessionId, nativeId) {
    try {
      if (typeof nativeId !== 'string' || !UUID.test(nativeId)) return;
      const path = join(
        this.brainDirectory,
        nativeId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      const { lines, cut } = await readTranscriptTail(path);
      this.swarms.delete(sessionId);
      const send = (sessionUpdate, content, timestamp) =>
        this.update(sessionId, {
          sessionUpdate,
          content: { type: 'text', text: content },
          ...(timestamp !== undefined ? { _meta: { timestamp } } : {}),
        });
      const rowTimestamp = (row) => {
        const raw = row?.created_at ?? row?.timestamp;
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1_000_000_000_000) return raw;
        if (typeof raw === 'string' && raw.trim()) {
          const parsed = Date.parse(raw);
          if (Number.isFinite(parsed) && parsed >= 1_000_000_000_000) return parsed;
        }
        return undefined;
      };
      let pending = [], // tool calls waiting for their GENERIC result, in order
        started = false;
      const members = new Map(); // toolCallId -> swarm member (swarm add calls)
      const extSubs = new Map(); // toolCallId -> parsed run_subagent params
      const flush = () => {
        for (const call of pending) {
          const extSub = extSubs.get(call.toolCallId);
          this.update(sessionId, {
            ...call,
            status: members.has(call.toolCallId) ? 'in_progress' : 'completed',
            ...(extSub
              ? {
                  _meta: {
                    antigravity: {
                      kind: 'subagent',
                      toolCallId: call.toolCallId,
                      agentId: call.toolCallId,
                      title: call.title,
                      ...(extSub.provider ? { provider: extSub.provider } : {}),
                      ...(extSub.model
                        ? { model: formatModelDisplayName(String(extSub.model)) || extSub.model }
                        : {}),
                      ...(extSub.effort ? { effort: String(extSub.effort).toLowerCase() } : {}),
                      ...(extSub.prompt ? { prompt: extSub.prompt } : {}),
                      background: true,
                      status: 'completed',
                    },
                  },
                }
              : {}),
          });
        }
        pending = [];
      };
      const begin = () => {
        if (started) return;
        started = true;
        if (cut) send('agent_message_chunk', REPLAY_TRUNCATED_NOTE);
      };
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || typeof row !== 'object') continue;
        if (row.type === 'GENERIC') {
          const call = pending.shift();
          if (!call) continue;
          const output = replayOutput(row.content);
          const member = members.get(call.toolCallId);
          if (member) {
            const failed = swarmAddFailed(row.content, false);
            this.update(sessionId, {
              ...call,
              status: failed ? 'failed' : 'in_progress',
              ...(output === undefined ? {} : { rawOutput: output }),
            });
            if (!failed)
              this.swarmMembers(sessionId).set(member.member, {
                toolCallId: call.toolCallId,
                afterSeq: swarmBriefSeq(row.content),
                replayed: true,
                needsBrief: member.truncatedBrief,
                sent: 'in_progress|',
              });
            continue;
          }
          const extSub = extSubs.get(call.toolCallId);
          if (extSub) {
            const parsedOut = parseExternalSubagentOutput(output);
            const failed =
              (parsedOut && parsedOut.ok === false) ||
              /^permission check failed/i.test(row.content ?? '') ||
              /Encountered error in step execution/i.test(row.content ?? '') ||
              /^Command exited with code [1-9]\d*/m.test(row.content ?? '');
            const status = failed ? 'failed' : 'completed';
            const summary =
              parsedOut?.error ||
              (typeof parsedOut?.response === 'string' && parsedOut.response.trim()
                ? truncateText(parsedOut.response, 360)
                : undefined);
            const provider = parsedOut?.provider || extSub.provider;
            const model =
              parsedOut?.model ||
              (extSub.model ? formatModelDisplayName(String(extSub.model)) || extSub.model : undefined);
            const effort =
              parsedOut?.effort ||
              (typeof extSub.effort === 'string' && extSub.effort.trim()
                ? extSub.effort.trim().toLowerCase()
                : extractEffortFromModel(typeof extSub.model === 'string' ? extSub.model : undefined));
            this.update(sessionId, {
              ...call,
              status,
              ...(output === undefined ? {} : { rawOutput: output }),
              _meta: {
                antigravity: {
                  kind: 'subagent',
                  toolCallId: call.toolCallId,
                  agentId: parsedOut?.runId || call.toolCallId,
                  title: call.title,
                  ...(provider ? { provider } : {}),
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {}),
                  ...(extSub.prompt ? { prompt: extSub.prompt } : {}),
                  ...(summary ? { summary } : {}),
                  background: true,
                  status,
                },
              },
            });
            continue;
          }
          this.update(sessionId, {
            ...call,
            status: /^Command exited with code [1-9]\d*/m.test(row.content ?? '')
              ? 'failed'
              : 'completed',
            ...(output === undefined ? {} : { rawOutput: output }),
          });
          continue;
        }
        flush();
        const ts = rowTimestamp(row);
        if (row.type === 'USER_INPUT') {
          const text = replayUserText(row.content);
          if (!text) continue;
          begin();
          send('user_message_chunk', text, ts);
        } else if (row.type === 'PLANNER_RESPONSE') {
          if (typeof row.content === 'string' && row.content.trim()) {
            begin();
            send('agent_message_chunk', row.content, ts);
          }
          if (Array.isArray(row.tool_calls)) {
            row.tool_calls.forEach((tool, i) => {
              if (!tool || typeof tool !== 'object') return;
              begin();
              const toolCallId = `agy-replay-${row.step_index}-${i}`;
              const extSub = extractExternalSubagentCall({
                tool_name: tool.name,
                tool_info: { parameters: tool.args },
              });
              if (extSub) {
                extSubs.set(toolCallId, extSub);
                const modelLabel =
                  typeof extSub.model === 'string'
                    ? formatModelDisplayName(extSub.model) || extSub.model
                    : undefined;
                const title =
                  (typeof extSub.role === 'string' && extSub.role.trim()) ||
                  modelLabel ||
                  'Alt Ajan';
                pending.push({
                  sessionUpdate: 'tool_call',
                  toolCallId,
                  title,
                  kind: 'other',
                  rawInput: extSub,
                });
                return;
              }
              const swarm = swarmCall(tool.name, tool.args, this.modelName);
              if (swarm?.member) members.set(toolCallId, swarm);
              pending.push({
                sessionUpdate: 'tool_call',
                toolCallId,
                title:
                  swarm?.title ?? (typeof tool.name === 'string' && tool.name ? tool.name : 'Araç'),
                kind: swarm?.kind ?? 'other',
                rawInput: swarm ? swarm.rawInput : tool.args,
              });
            });
          }
        }
      }
      flush();
      if (cut && !started) send('agent_message_chunk', REPLAY_TRUNCATED_NOTE);
      await this.syncSwarm(sessionId, nativeId, true);
    } catch {
      /* History replay is best effort; the conversation itself still continues. */
    }
  }
  modelName = (value) => this.models.find((m) => m.value === value)?.name;
  swarmMembers(sessionId) {
    let swarm = this.swarms.get(sessionId);
    if (!swarm)
      this.swarms.set(sessionId, (swarm = { members: new Map(), chain: Promise.resolve() }));
    return swarm.members;
  }
  // Mirrors swarm/board.jsonl and members.json onto the member rows: reply text and status.
  // Serialized per session; never throws (missing or damaged files leave the rows as they are).
  syncSwarm(sessionId, nativeId, replay = false) {
    const swarm = this.swarms.get(sessionId);
    if (!swarm?.members.size) return Promise.resolve();
    swarm.chain = swarm.chain.then(async () => {
      try {
        const directory = swarmDirectory(this.brainDirectory, nativeId);
        if (!directory) return;
        const [board, info] = await Promise.all([readBoard(directory), readMembers(directory)]);
        for (const [name, member] of swarm.members) {
          // Rows replayed from history live in an earlier turn; only that replay updates them.
          if (member.replayed && !replay) continue;
          if (member.needsBrief && member.afterSeq) {
            const brief = board.find((row) => row.seq === member.afterSeq && row.kind === 'brief');
            if (brief) {
              member.needsBrief = false;
              const task = brief.text.replace(/^@\S+\s+/, '').slice(0, SWARM_BRIEF_LIMIT);
              this.update(sessionId, {
                sessionUpdate: 'tool_call_update',
                toolCallId: member.toolCallId,
                rawInput: { description: task },
              });
            }
          }
          const posts = board.filter((row) => row.agent === name && row.seq > member.afterSeq);
          let state = 'in_progress';
          for (const post of posts) {
            if (SWARM_FAILED.test(post.text.trim())) state = 'failed';
            else if (SWARM_DONE.test(post.text.trim())) state = 'completed';
          }
          const details = info.get(name);
          if (
            state === 'in_progress' &&
            details &&
            (details.killed === true || SWARM_ENDED_PHASES.has(details.phase))
          )
            state = 'completed';
          const reply = posts.length ? swarmReplyText(posts.map((post) => post.text.trim())) : '';
          const sent = state + '|' + reply;
          if (sent === member.sent) continue;
          member.sent = sent;
          this.update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: member.toolCallId,
            status: state,
            ...(reply
              ? { content: [{ type: 'content', content: { type: 'text', text: reply } }] }
              : {}),
          });
        }
      } catch {
        /* Swarm mirroring is best effort. */
      }
    });
    return swarm.chain;
  }
  async setSessionConfigOption(p) {
    const s = this.session(p.sessionId);
    if (this.active.has(p.sessionId)) throw new Error('Yanıt sürerken ayarlar değiştirilemez.');
    const prevModel = s.model;
    const prevMode = s.mode;
    if (p.configId === 'model') {
      if (!this.models.some((m) => m.value === p.value))
        throw new Error('Desteklenmeyen Antigravity modeli.');
      if (!isOrchestratorModel(p.value)) {
        s.lastStandardModel = p.value;
      } else if (!isOrchestratorModel(s.model)) {
        s.lastStandardModel = s.model;
      }
      s.model = p.value;
    } else if (p.configId === 'collaboration_mode') {
      if (p.value === 'standard') {
        if (isOrchestratorModel(s.model)) {
          const fallback =
            s.lastStandardModel &&
            !isOrchestratorModel(s.lastStandardModel) &&
            this.models.some((m) => m.value === s.lastStandardModel)
              ? s.lastStandardModel
              : this.firstStandardModel();
          if (fallback) s.model = fallback;
        }
      } else if (isOrchestratorModel(p.value) && this.models.some((m) => m.value === p.value)) {
        if (!isOrchestratorModel(s.model)) {
          s.lastStandardModel = s.model;
        }
        s.model = p.value;
      } else {
        throw new Error('Geçersiz çalışma kipi.');
      }
    } else if (p.configId === 'mode') {
      if (!modes.some((m) => m.value === p.value)) throw new Error('Geçersiz izin kipi.');
      s.mode = p.value;
    } else throw new Error('Bilinmeyen oturum ayarı.');
    if (s.model !== prevModel || s.mode !== prevMode) {
      await this.terminateProcess(p.sessionId);
    }
    await this.save(p.sessionId, s);
    return { configOptions: this.options(s) };
  }
  update(id, update) {
    this.notify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update } });
  }
  startSubagentWatcher(sessionId, proc, info) {
    const key = info.agentId || info.toolCallId;
    if (!key || !info.outputFile) return;
    const existing = proc.subagentWatchers.get(key);
    if (existing) {
      existing.toolCallId = info.toolCallId;
      existing.role = info.role || existing.role;
      existing.prompt = info.prompt || existing.prompt;
      existing.outputFile = info.outputFile;
      return;
    }
    const watcher = {
      ...info,
      lastSerialized: '',
      lastStatus: 'in_progress',
      completedPolls: 0,
      reading: false,
      timer: null,
    };
    const poll = async () => {
      if (proc.closed || watcher.reading) return;
      watcher.reading = true;
      try {
        const raw = await readFile(watcher.outputFile, 'utf8');
        const parsed = parseSubagentTranscript(raw);
        const serialized = JSON.stringify(parsed);
        if (serialized !== watcher.lastSerialized) {
          watcher.lastSerialized = serialized;
          watcher.lastStatus = parsed.status;
          watcher.completedPolls = 0;
          this.update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: watcher.toolCallId,
            title: watcher.title,
            kind: 'other',
            status: parsed.status,
            _meta: {
              antigravity: {
                kind: 'subagent_update',
                toolCallId: watcher.toolCallId,
                agentId: watcher.agentId,
                status: parsed.status,
                ...(parsed.summary ? { summary: parsed.summary } : {}),
                outputFile: watcher.outputFile,
                ...(watcher.prompt ? { prompt: watcher.prompt } : {}),
                ...(watcher.role ? { role: watcher.role } : {}),
                ...(parsed.provider ? { provider: parsed.provider } : { provider: 'antigravity' }),
                ...(parsed.model ? { model: parsed.model } : {}),
                ...(parsed.effort ? { effort: parsed.effort } : {}),
                activities: parsed.activities,
              },
            },
          });
        } else if (watcher.lastStatus === 'completed' || watcher.lastStatus === 'failed') {
          watcher.completedPolls += 1;
          if (watcher.completedPolls >= 100) {
            clearInterval(watcher.timer);
            watcher.timer = null;
          }
        }
      } catch {
        /* Transcript file may not exist yet right after launch. */
      } finally {
        watcher.reading = false;
      }
    };
    watcher.timer = setInterval(() => {
      void poll();
    }, 600);
    watcher.timer.unref();
    proc.subagentWatchers.set(key, watcher);
    void poll();
  }
  startExternalSubagentWatcher(sessionId, proc, info) {
    const key = 'ext-' + info.toolCallId;
    if (proc.subagentWatchers.has(key)) return;
    const watcher = {
      ...info,
      matchedFile: null,
      lastSerialized: '',
      reading: false,
      timer: null,
      stopped: false,
    };
    const poll = async () => {
      if (proc.closed || watcher.stopped || watcher.reading) return;
      watcher.reading = true;
      try {
        if (!watcher.matchedFile) {
          const entries = await readdir(DEFAULT_SUBAGENTS_STATE_DIR);
          let bestPath = null;
          let bestStarted = 0;
          for (const entry of entries) {
            if (!entry.endsWith('.json')) continue;
            const full = join(DEFAULT_SUBAGENTS_STATE_DIR, entry);
            try {
              const data = JSON.parse(await readFile(full, 'utf8'));
              if (!data || typeof data !== 'object') continue;
              if (typeof data.startedAt !== 'number' || data.startedAt < watcher.startedAt - 6000) {
                continue;
              }
              const promptMatch =
                watcher.prompt &&
                typeof data.prompt === 'string' &&
                data.prompt.trim() === watcher.prompt.trim();
              if (promptMatch && data.startedAt >= bestStarted) {
                bestStarted = data.startedAt;
                bestPath = full;
              }
            } catch {
              /* ignore unreadable temp files */
            }
          }
          if (bestPath) watcher.matchedFile = bestPath;
        }
        if (!watcher.matchedFile) return;
        const data = JSON.parse(await readFile(watcher.matchedFile, 'utf8'));
        const serialized = JSON.stringify({
          status: data.status,
          summary: data.summary,
          provider: data.provider,
          model: data.model,
          effort: data.effort,
          activities: data.activities,
        });
        if (serialized !== watcher.lastSerialized) {
          watcher.lastSerialized = serialized;
          this.update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: watcher.toolCallId,
            title: data.role || watcher.title,
            kind: 'other',
            status: data.status || 'in_progress',
            _meta: {
              antigravity: {
                kind: 'subagent_update',
                toolCallId: watcher.toolCallId,
                agentId: data.runId || watcher.toolCallId,
                status: data.status || 'in_progress',
                ...(data.summary ? { summary: data.summary } : {}),
                ...(data.prompt
                  ? { prompt: data.prompt }
                  : watcher.prompt
                    ? { prompt: watcher.prompt }
                    : {}),
                ...(data.provider ? { provider: data.provider } : {}),
                ...(data.model ? { model: data.model } : {}),
                ...(data.effort ? { effort: data.effort } : {}),
                ...(Array.isArray(data.activities) ? { activities: data.activities } : {}),
              },
            },
          });
        }
        if (data.status === 'completed' || data.status === 'failed') {
          watcher.stopped = true;
          if (watcher.timer) {
            clearInterval(watcher.timer);
            watcher.timer = null;
          }
        }
      } catch {
        /* State dir or file may not exist yet. */
      } finally {
        watcher.reading = false;
      }
    };
    watcher.timer = setInterval(() => {
      void poll();
    }, 500);
    watcher.timer.unref();
    proc.subagentWatchers.set(key, watcher);
    void poll();
  }
  stopAllSubagentWatchers(proc) {
    if (!proc?.subagentWatchers) return;
    for (const watcher of proc.subagentWatchers.values()) {
      if (watcher.timer) clearInterval(watcher.timer);
    }
    proc.subagentWatchers.clear();
  }
  async terminateProcess(sessionId, signal = null) {
    const proc = this.processes.get(sessionId);
    if (!proc || proc.closed) {
      this.processes.delete(sessionId);
      return;
    }
    proc.closing = true;
    this.stopAllSubagentWatchers(proc);
    try {
      if (signal) {
        proc.child.kill(signal);
      } else {
        proc.child.stdin.end();
      }
    } catch {
      /* ignore */
    }
    if (!proc.timer) {
      proc.timer = setTimeout(() => {
        try {
          proc.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
      proc.timer.unref();
    }
    await proc.done;
  }
  ensureProcess(sessionId, s) {
    const currentOrchestratorKey = orchestratorKey(s.orchestrator);
    const existing = this.processes.get(sessionId);
    if (
      existing &&
      !existing.closed &&
      !existing.closing &&
      existing.model === s.model &&
      existing.mode === s.mode &&
      existing.orchestratorKey === currentOrchestratorKey
    ) {
      return existing;
    }
    const child = this.spawnProcess(this.cli, buildArgs(s), {
      cwd: s.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const proc = {
      child,
      model: s.model,
      mode: s.mode,
      orchestratorKey: currentOrchestratorKey,
      closing: false,
      closed: false,
      timer: null,
      done,
      finish,
      currentTurn: null,
      parseError: null,
      tools: new Set(),
      subagents: new Set(),
      subagentWatchers: new Map(),
      lastResponseStepIndex: null,
      lastResponseEndedWithNewline: true,
    };
    this.processes.set(sessionId, proc);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('Antigravity yanıt satırı çok büyük.');
        const event = JSON.parse(line);
        if (event.event === 'init' && event.conversation_id) {
          s.nativeId = event.conversation_id;
          void this.save(sessionId, s).catch(() => {});
        }
        if (event.event === 'step_update') {
          const u = event.step_update;
          if (u.step_type === 'agent_response' && u.text_delta) {
            if (
              proc.lastResponseStepIndex !== null &&
              proc.lastResponseStepIndex !== u.step_index &&
              !proc.lastResponseEndedWithNewline &&
              !u.text_delta.startsWith('\n')
            ) {
              this.update(sessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '\n\n' },
              });
            }
            proc.lastResponseStepIndex = u.step_index ?? proc.lastResponseStepIndex;
            proc.lastResponseEndedWithNewline = u.text_delta.endsWith('\n');
            if (proc.currentTurn) proc.currentTurn.emitted = true;
            this.update(sessionId, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: u.text_delta },
            });
          }
          if (u.step_type === 'tool') {
            const id = 'agy-' + u.step_index,
              known = proc.tools.has(id);
            proc.tools.add(id);
            const extSub = extractExternalSubagentCall(u);
            if (extSub) {
              const status =
                u.state === 'DONE' ? (u.tool_info?.error ? 'failed' : 'completed') : 'in_progress';
              const parsedOut =
                u.state === 'DONE' ? parseExternalSubagentOutput(u.tool_info?.output) : null;
              const finalStatus = parsedOut && parsedOut.ok === false ? 'failed' : status;
              const provider =
                parsedOut?.provider ||
                (typeof extSub.provider === 'string' && extSub.provider.trim()
                  ? extSub.provider.trim()
                  : undefined);
              const model =
                parsedOut?.model ||
                formatModelDisplayName(typeof extSub.model === 'string' ? extSub.model : undefined);
              const effort =
                parsedOut?.effort ||
                (typeof extSub.effort === 'string' && extSub.effort.trim()
                  ? extSub.effort.trim().toLowerCase()
                  : extractEffortFromModel(
                      typeof extSub.model === 'string' ? extSub.model : undefined
                    ));
              const prompt =
                typeof extSub.prompt === 'string' && extSub.prompt.trim()
                  ? extSub.prompt.trim()
                  : undefined;
              const title =
                (typeof extSub.role === 'string' && extSub.role.trim()) ||
                parsedOut?.role ||
                model ||
                'Alt Ajan';
              const summary =
                parsedOut?.error ||
                (typeof parsedOut?.response === 'string' && parsedOut.response.trim()
                  ? truncateText(parsedOut.response, 360)
                  : undefined);
              this.update(sessionId, {
                sessionUpdate: known ? 'tool_call_update' : 'tool_call',
                toolCallId: id,
                title,
                kind: 'other',
                status: finalStatus,
                rawInput: extSub,
                rawOutput: u.tool_info?.output,
                _meta: {
                  antigravity: {
                    kind: known && u.state === 'DONE' ? 'subagent_update' : 'subagent',
                    toolCallId: id,
                    agentId: parsedOut?.runId || id,
                    title,
                    ...(provider ? { provider } : {}),
                    ...(model ? { model } : {}),
                    ...(effort ? { effort } : {}),
                    ...(prompt ? { prompt } : {}),
                    ...(summary ? { summary } : {}),
                    background: true,
                    status: finalStatus,
                  },
                },
              });
              if (u.state === 'DONE' && typeof u.tool_info?.error === 'string' && /permission check failed|user denied permission/i.test(u.tool_info.error) && proc.currentTurn) {
                proc.currentTurn.deniedTools.push('run_subagent');
              }
              if (u.state !== 'DONE') {
                this.startExternalSubagentWatcher(sessionId, proc, {
                  toolCallId: id,
                  title,
                  prompt,
                  startedAt: Date.now(),
                });
              } else if (parsedOut?.runId) {
                const runFile = join(DEFAULT_SUBAGENTS_STATE_DIR, `${parsedOut.runId}.json`);
                void readFile(runFile, 'utf8')
                  .then((raw) => {
                    const saved = JSON.parse(raw);
                    if (Array.isArray(saved.activities) && saved.activities.length > 0) {
                      this.update(sessionId, {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: id,
                        title,
                        kind: 'other',
                        status: finalStatus,
                        _meta: {
                          antigravity: {
                            kind: 'subagent_update',
                            toolCallId: id,
                            agentId: parsedOut.runId,
                            status: finalStatus,
                            ...(summary ? { summary } : {}),
                            ...(saved.provider ? { provider: saved.provider } : {}),
                            ...(saved.model ? { model: saved.model } : {}),
                            ...(saved.effort ? { effort: saved.effort } : {}),
                            activities: saved.activities,
                          },
                        },
                      });
                    }
                  })
                  .catch(() => {});
              }
            } else {
              const swarm = swarmCall(u.tool_name, u.tool_info?.parameters, this.modelName);
              const doneFlag = u.state === 'DONE';
              let status = doneFlag ? (u.tool_info?.error ? 'failed' : 'completed') : 'in_progress';
              if (swarm?.member) {
                if (doneFlag && !swarmAddFailed(u.tool_info?.output, u.tool_info?.error))
                  status = 'in_progress';
                else if (doneFlag) status = 'failed';
                if (doneFlag && status !== 'failed')
                  this.swarmMembers(sessionId).set(swarm.member, {
                    toolCallId: id,
                    afterSeq: swarmBriefSeq(u.tool_info?.output),
                    sent: 'in_progress|',
                  });
              }
              const data = {
                sessionUpdate: known ? 'tool_call_update' : 'tool_call',
                toolCallId: id,
                title: swarm?.title ?? (u.tool_name || 'Araç'),
                kind: swarm?.kind ?? 'other',
                status,
                rawInput: swarm ? swarm.rawInput : u.tool_info?.parameters,
                rawOutput: u.tool_info?.output,
                ...(swarm?.member
                  ? {
                      _meta: {
                        antigravity: {
                          kind: 'subagent',
                          toolCallId: id,
                          agentId: `swarm-${swarm.member}`,
                          title: swarm.title,
                          provider: 'antigravity',
                          ...(swarm.rawInput?.description
                            ? { prompt: String(swarm.rawInput.description) }
                            : {}),
                          background: true,
                          status,
                        },
                      },
                    }
                  : {}),
              };
              this.update(sessionId, data);
              if (
                doneFlag &&
                typeof u.tool_info?.error === 'string' &&
                /permission check failed|user denied permission/i.test(u.tool_info.error) &&
                proc.currentTurn
              ) {
                const rawInner = u.tool_info?.parameters?.ToolName ?? u.tool_info?.parameters?.tool_name;
                const deniedName =
                  u.tool_name === 'call_mcp_tool' && typeof rawInner === 'string'
                    ? unwrapQuotedString(rawInner)
                    : u.tool_name || 'araç';
                proc.currentTurn.deniedTools.push(deniedName);
              }
              if (doneFlag && SWARM_SYNC_TOOLS.has(u.tool_name))
                this.syncSwarm(sessionId, s.nativeId);
            }
          }
          if (u.step_type === 'subagent') {
            const list = Array.isArray(u.subagent_info?.subagents) ? u.subagent_info.subagents : [];
            list.forEach((sub, idx) => {
              if (!sub || typeof sub !== 'object') return;
              const id = `agy-sub-${u.step_index}-${idx}`;
              const known = proc.subagents.has(id);
              proc.subagents.add(id);
              const title = sub.role || sub.type_name || 'Alt Ajan';
              const role = typeof sub.type_name === 'string' ? sub.type_name : undefined;
              const prompt =
                typeof sub.initial_prompt === 'string' && sub.initial_prompt.trim()
                  ? sub.initial_prompt
                  : undefined;
              const agentId =
                typeof sub.conversation_id === 'string' && sub.conversation_id
                  ? sub.conversation_id
                  : undefined;
              const outputFile = filePathFromUri(sub.log_uri);
              this.update(sessionId, {
                sessionUpdate: known ? 'tool_call_update' : 'tool_call',
                toolCallId: id,
                title,
                kind: 'other',
                status: 'in_progress',
                rawInput: {
                  role: sub.role,
                  type: role,
                  prompt,
                },
                _meta: {
                  antigravity: {
                    kind: 'subagent',
                    title,
                    provider: 'antigravity',
                    ...(role ? { role } : {}),
                    ...(prompt ? { prompt } : {}),
                    ...(agentId ? { agentId } : {}),
                    ...(outputFile ? { outputFile } : {}),
                    background: true,
                    status: 'in_progress',
                  },
                },
              });
              if (agentId && outputFile) {
                this.startSubagentWatcher(sessionId, proc, {
                  toolCallId: id,
                  agentId,
                  title,
                  role,
                  prompt,
                  outputFile,
                });
              }
            });
          }
        }
        if (event.event === 'result') {
          const final = event.result;
          if (final?.conversation_id) {
            s.nativeId = final.conversation_id;
          }
          const turn = proc.currentTurn;
          if (turn) {
            proc.currentTurn = null;
            this.active.delete(sessionId);
            void (async () => {
              try {
                await this.save(sessionId, s);
                await this.syncSwarm(sessionId, s.nativeId);
              } catch {
                /* ignore */
              }
              if (turn.cancelled || ['CANCELED', 'INTERRUPTED'].includes(final?.status)) {
                turn.resolve({ stopReason: 'cancelled' });
              } else if (final?.status !== 'SUCCESS') {
                turn.reject(
                  new Error(
                    final?.error ||
                      'Antigravity yanıtı tamamlanamadı. Oturum açma ve bağlantı durumunu kontrol edin.'
                  )
                );
              } else {
                if (!turn.emitted) {
                  if (final.response) {
                    this.update(sessionId, {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'text', text: final.response },
                    });
                  } else if (turn.deniedTools?.length > 0) {
                    const names = [...new Set(turn.deniedTools)].join(', ');
                    this.update(sessionId, {
                      sessionUpdate: 'agent_message_chunk',
                      content: {
                        type: 'text',
                        text: `Bazı araç çağrıları izin kipi nedeniyle engellendi (${names}). Alt çubuktan **Otomatik onay** kipine geçerek veya aracı onaylayarak yeniden deneyebilirsiniz.`,
                      },
                    });
                  }
                }
                turn.resolve({ stopReason: 'end_turn' });
              }
            })();
          }
        }
      } catch (error) {
        proc.parseError = error;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      proc.closed = true;
      clearTimeout(proc.timer);
      this.stopAllSubagentWatchers(proc);
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      const turn = proc.currentTurn;
      proc.currentTurn = null;
      this.active.delete(sessionId);
      finish();
      if (turn) turn.reject(error);
    });
    child.on('close', async (code) => {
      proc.closed = true;
      clearTimeout(proc.timer);
      this.stopAllSubagentWatchers(proc);
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      const turn = proc.currentTurn;
      proc.currentTurn = null;
      this.active.delete(sessionId);
      try {
        await this.save(sessionId, s);
        await this.syncSwarm(sessionId, s.nativeId);
        if (turn) {
          if (turn.cancelled) {
            turn.resolve({ stopReason: 'cancelled' });
          } else if (proc.parseError) {
            turn.reject(proc.parseError);
          } else {
            turn.reject(
              new Error(
                code !== 0
                  ? 'Antigravity yanıtı tamamlanamadı. Oturum açma ve bağlantı durumunu kontrol edin.'
                  : 'Antigravity bağlantısı yanıt tamamlanmadan kapandı.'
              )
            );
          }
        }
      } catch (error) {
        if (turn) turn.reject(error);
      } finally {
        finish();
      }
    });
    return proc;
  }
  async prompt(p) {
    const s = this.session(p.sessionId),
      text = promptText(p.prompt);
    if (this.active.has(p.sessionId)) throw new Error('Bu oturumda zaten bir yanıt hazırlanıyor.');
    if (s.mcpServers && Object.keys(s.mcpServers).length > 0) {
      await this.materializeMcpServers(s);
    }
    const live = this.refreshOrchestratorConfig();
    if (live) {
      if (live.settings) s.orchestrator = { ...live.settings };
      else delete s.orchestrator;
    }
    const existing = this.processes.get(p.sessionId);
    if (
      existing &&
      (existing.model !== s.model ||
        existing.mode !== s.mode ||
        existing.orchestratorKey !== orchestratorKey(s.orchestrator))
    ) {
      await this.terminateProcess(p.sessionId);
    }
    const proc = this.ensureProcess(p.sessionId, s);
    return new Promise((resolve, reject) => {
      const turn = {
        resolve,
        reject,
        emitted: false,
        cancelled: false,
        deniedTools: [],
        child: proc.child,
        done: proc.done,
      };
      proc.currentTurn = turn;
      proc.lastResponseStepIndex = null;
      proc.lastResponseEndedWithNewline = true;
      this.active.set(p.sessionId, turn);
      proc.child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
    });
  }
  async cancel(p) {
    const state = this.active.get(p.sessionId);
    const proc = this.processes.get(p.sessionId);
    if (state && !state.cancelled) {
      state.cancelled = true;
      if (proc) {
        proc.closing = true;
        proc.child.kill('SIGINT');
        proc.timer = setTimeout(() => {
          try {
            proc.child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 5000);
        proc.timer.unref();
      }
    }
    return {};
  }
  async closeSession(p) {
    const state = this.active.get(p.sessionId);
    if (state) {
      await this.cancel(p);
      await state.done;
    } else if (this.processes.has(p.sessionId)) {
      await this.terminateProcess(p.sessionId);
    }
    this.sessions.delete(p.sessionId);
    return {};
  }
  async shutdown() {
    const ids = new Set([...this.active.keys(), ...this.processes.keys()]);
    for (const id of ids) {
      if (this.active.has(id)) {
        await this.cancel({ sessionId: id });
      } else {
        await this.terminateProcess(id);
      }
    }
  }
}
export function serve() {
  const write = (x) => process.stdout.write(JSON.stringify(x) + '\n');
  const bridge = new AntigravityBridge({ notify: write });
  const methods = {
    initialize: 'initialize',
    'session/new': 'newSession',
    'session/load': 'loadSession',
    'session/prompt': 'prompt',
    'session/set_config_option': 'setSessionConfigOption',
    'session/cancel': 'cancel',
    'session/close': 'closeSession',
  };
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
      const method = methods[request.method];
      if (!method) throw new Error('Desteklenmeyen ACP yöntemi.');
      const result = await bridge[method](request.params || {});
      if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      if (request?.id !== undefined)
        write({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } });
    }
  });
  input.on('close', () => bridge.shutdown());
  process.on('SIGTERM', () => bridge.shutdown().then(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  serve();
