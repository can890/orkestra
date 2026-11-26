import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rebuildAntigravityUserChunk } from '@orkestra/core/runtimes/acp/api/replay-node';
import {
  ACP_CANCEL_GRACE_MS,
  ACP_PROBE_TIMEOUT_MS,
  AGY_TRANSPORT_ENV,
  AcpChildConnection,
  QUEUE_REASON,
  STEER_ACCEPT_TIMEOUT_MS,
  acpToolForCommand,
  acpToolStep,
  buildAcpArgs,
  isBuiltinMcpPermission,
  isSpawnMessageOf,
  isSubagentCancelledMessage,
  normalizeTransport,
  parseCreatedSubagent,
  permissionResponse,
  permissionToolName,
  probeAgyAcp,
  streamJsonOnlyReason,
  subagentOfToolCallId,
  subagentToolTitle,
} from './agy-acp-transport.mjs';

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
  ['gemini-4-neon-high', 'Gemini 4 Neon (Yüksek)'],
  ['gemini-4-neon-xhigh', 'Gemini 4 Neon (Çok Yüksek)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Orta)'],
  ['gemini-4-neon-low', 'Gemini 4 Neon (Düşük)'],
  ['gemini-4-carbon-high', 'Gemini 4 Carbon (Yüksek)'],
  ['gemini-4-carbon-medium', 'Gemini 4 Carbon (Orta)'],
  ['gemini-4-carbon-low', 'Gemini 4 Carbon (Düşük)'],
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
const ATTACHMENT_MIME_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
};
function extensionForMime(mimeType, uri = '') {
  const normalized = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (ATTACHMENT_MIME_EXTENSIONS[normalized]) return ATTACHMENT_MIME_EXTENSIONS[normalized];
  if (normalized.startsWith('image/')) {
    const sub = normalized
      .slice('image/'.length)
      .split('+')[0]
      .replace(/[^a-z0-9]/g, '');
    if (sub && sub.length <= 10) return sub;
  }
  if (typeof uri === 'string' && uri) {
    const match = /\.([a-z0-9]{1,10})(?:[?#]|$)/i.exec(uri);
    if (match) return match[1].toLowerCase();
  }
  return 'bin';
}
function validatePromptBlocksInput(blocks, sessionId) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('İleti içeriği boş olamaz.');
  }
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error('Geçersiz oturum kimliği.');
  }
}
function needsAsyncMaterialization(blocks) {
  return blocks.some(
    (block) =>
      block &&
      typeof block === 'object' &&
      (block.type === 'image' ||
        (block.type === 'resource' &&
          block.resource &&
          typeof block.resource === 'object' &&
          typeof block.resource.text !== 'string' &&
          typeof block.resource.blob === 'string' &&
          block.resource.blob.length > 0))
  );
}
function materializeSyncBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('Geçersiz ileti içeriği bloğu.');
  }
  if (block.type === 'text') {
    if (typeof block.text !== 'string') {
      throw new Error('Metin bloğu geçersiz.');
    }
    return block.text;
  }
  if (block.type === 'resource') {
    const resource = block.resource;
    if (!resource || typeof resource !== 'object') {
      throw new Error('Kaynak bloğu geçersiz.');
    }
    if (typeof resource.text === 'string') {
      const uri =
        typeof resource.uri === 'string' && resource.uri.trim() ? resource.uri.trim() : 'kaynak';
      return `[Ek kaynak: ${uri}]\n${resource.text}`;
    }
    throw new Error('Kaynak bloğunda metin veya ikili içerik bulunamadı.');
  }
  if (block.type === 'resource_link') {
    const target = block.uri || block.name;
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('Bağlantı bloğunda dosya adresi veya adı bulunamadı.');
    }
    return `[Ek dosya: ${target}]`;
  }
  throw new Error(`Antigravity bu ileti içeriği türünü desteklemiyor: ${String(block.type)}.`);
}
export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('İleti içeriği boş olamaz.');
  if (blocks.some((b) => !b || b.type !== 'text'))
    throw new Error('Antigravity sohbeti şu anda yalnızca metin iletilerini destekler.');
  return blocks.map((b) => b.text).join('\n');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// agy reads the next stream-json `user` line only after the running turn's `result` (captured with
// agy 1.5.17: a line written mid-turn, also with `queuedMessages: send-immediately`, was answered
// only after the first result, also while the turn was actively stepping). On the stream-json
// transport a message sent while a turn runs therefore cannot join it: steering answers
// `queueRequired` and the runtime sends the message as the next prompt. The `agy acp` transport
// (see agy-acp-transport.mjs) can: a second `session/prompt` joins the running turn.
// Replay limits: a huge conversation must never stall session/load.
export const REPLAY_MAX_BYTES = 5 * 1024 * 1024;
export const REPLAY_MAX_LINES = 2000;
const REPLAY_OUTPUT_LIMIT = 4000;
const REPLAY_TRUNCATED_NOTE =
  '_Önceki konuşma geçmişi kısaltıldı; yalnızca son adımlar gösteriliyor._\n\n';
export function replayUserText(content) {
  if (typeof content !== 'string') return '';
  const start = content.indexOf('<USER_REQUEST>');
  if (start < 0) return '';
  const from = start + '<USER_REQUEST>'.length,
    end = content.lastIndexOf('</USER_REQUEST>');
  return content.slice(from, end >= from ? end : undefined).trim();
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
// ACP only allows a fixed `kind` set and the client rejects a whole `tool_call` carrying any
// other value ("Invalid params"), so a sub-agent row is sent as `kind: 'other'` and Orkestra
// reads the real kind from `_meta.orkestra.toolKind`.
export const SUBAGENT_TOOL_META = Object.freeze({
  orkestra: Object.freeze({ toolKind: 'subagent' }),
});
// A sub-agent row whose end this adapter still follows (a live agy process keeps syncing it): the
// row stays running after its turn closes. Without it, a turn's end leaves the row "outcome
// unknown" in Orkestra, never "done".
export const DETACHED_SUBAGENT_TOOL_META = Object.freeze({
  orkestra: Object.freeze({ toolKind: 'subagent', detached: true }),
});
// A sub-agent row whose end nobody recorded (agy stopped before the call returned).
export const UNKNOWN_SUBAGENT_TOOL_META = Object.freeze({
  orkestra: Object.freeze({ toolKind: 'subagent', statusUnknown: true }),
});
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
        kind: 'other',
        meta: SUBAGENT_TOOL_META,
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
// --- Background tasks -----------------------------------------------------------------------
// agy can move a tool (usually `run_command`) to the background. Its stream-json output then keeps
// that tool step ACTIVE until the task ends and holds every later step (the agent's own "started,
// waiting" reply included) until then; the turn result only comes after all background tasks end.
// The conversation transcript (brain/<id>/.system_generated/logs/transcript.jsonl) shows what the
// stream holds back: a `GENERIC` step with status `RUNNING` whose text starts "Tool is running as
// a background task with task id: <conversation>/task-<step>", and the agent's replies. The
// adapter tails that file while a tool runs so the row says what is running, the agent's replies
// are not hidden for the whole wait, and the task log is visible as the row's output.
export const BACKGROUND_POLL_MS = 1500;
export const BACKGROUND_LOG_TAIL_BYTES = 4000;
const BACKGROUND_SUMMARY_LIMIT = 160;
const BACKGROUND_TASK_START = /Tool is running as a background task with task id: (\S+)/;
const TASK_FINISHED =
  /Task id "([^"]+)" finished with result:\s*\n?([\s\S]*?)(?:\n\s*Log: file:\/\/\S*)?\s*(?:<\/SYSTEM_MESSAGE>)?\s*$/;
const COMMAND_FAILED = /^Command exited with code [1-9]\d*/m;
// The stopped-task text says what happened to the task itself: agy stops tracking a task when its
// process ends, but the task's own process is not killed with it. On an explicit Stop the adapter
// ends the task's processes itself when it can prove which ones they are (`terminated`).
const BACKGROUND_STOPPED_NOTES = {
  cancelled:
    'Tur durduruldu. Antigravity bu arka plan görevini artık izlemiyor; komut kendi başına çalışmayı sürdürebilir.',
  terminated: 'Tur durduruldu. Bu arka plan görevinin komutu da sonlandırıldı.',
  error: 'Antigravity turu hatayla bitti; arka plan görevi artık izlenmiyor ve sonucu bilinmiyor.',
  lost: 'Antigravity bağlantısı görev bitmeden kapandı; görevin sonucu bilinmiyor.',
  detached:
    'Konuşma kapatıldı; Antigravity bu arka plan görevini sürdürüyor, sonucu bu sohbette görünmeyecek.',
  replay:
    'Antigravity bu görevin bitişini kaydetmedi (oturum görev sürerken durduruldu ya da yeniden başlatıldı); sonucu bilinmiyor.',
};
// --- Ending a stopped turn's background tasks ---------------------------------------------------
// SIGINT makes agy exit, but a background task's shell is re-parented to PID 1 and keeps running
// (captured with agy 1.5.17: `zsh -c <CommandLine>` stays alive after agy exits). agy exposes only
// the task id and a log path, no pid. While agy still runs, though, the task is provably its own:
// a direct child of this agy process whose command line is exactly `<shell> -c <CommandLine>` of a
// task this turn tracks. Only such processes (and their descendants, or the task's own process
// group) are ever signalled; nothing is matched by command name alone. When the match is missing
// or ambiguous, the task is left running and its row says so.
export const TASK_KILL_GRACE_MS = 2000;
const TASK_KILL_PLATFORMS = new Set(['darwin', 'linux']);
// `ps -A -ww -o pid=,ppid=,pgid=,args=` output (same flags on macOS and Linux procps).
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match)
      rows.push({ pid: +match[1], ppid: +match[2], pgid: +match[3], args: match[4].trimEnd() });
  }
  return rows;
}
function listProcessTable() {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,args='],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout)))
    );
  });
}
// `<shell> -c <command>` exactly: one shell token, then the task's whole command line.
function runsCommand(args, command) {
  const marker = ' -c ';
  const at = args.indexOf(marker);
  return (
    at > 0 && !/\s/.test(args.slice(0, at)) && args.slice(at + marker.length).trim() === command
  );
}
// The process trees of `tasks` that provably belong to the agy process `agyPid`. Tasks sharing one
// command line are matched only when exactly as many such children exist.
export function ownedTaskProcesses(table, agyPid, tasks) {
  const agy = table.find((row) => row.pid === agyPid);
  const groups = new Map();
  for (const task of tasks) {
    const command = typeof task.command === 'string' ? task.command.trim() : '';
    if (!command || command.includes('\n')) continue;
    if (!groups.has(command)) groups.set(command, []);
    groups.get(command).push(task);
  }
  const owned = { tasks: [], trees: [] };
  for (const [command, group] of groups) {
    const roots = table.filter((row) => row.ppid === agyPid && runsCommand(row.args, command));
    if (!roots.length || roots.length !== group.length) continue;
    owned.tasks.push(...group);
    for (const root of roots) {
      const members = [];
      const visit = (pid, depth) => {
        if (depth > 64) return;
        for (const child of table.filter((row) => row.ppid === pid)) visit(child.pid, depth + 1);
        members.push(table.find((row) => row.pid === pid));
      };
      visit(root.pid, 0);
      owned.trees.push({
        root: root.pid,
        members: members.filter(Boolean),
        // The task's own process group, never agy's.
        ...(root.pgid === root.pid && root.pgid !== agy?.pgid ? { group: root.pgid } : {}),
      });
    }
  }
  return owned;
}
// ACP keeps `kind`/`status` to fixed sets; the background state travels in `_meta.orkestra`.
export function backgroundTaskMeta(taskId, state) {
  return { orkestra: { backgroundTask: { taskId, state } } };
}
export function backgroundTaskTitle(state, summary) {
  const label =
    state === 'running'
      ? 'Arka planda çalışıyor'
      : state === 'completed'
        ? 'Arka plan görevi bitti'
        : state === 'failed'
          ? 'Arka plan görevi başarısız oldu'
          : 'Arka plan görevi durduruldu';
  return summary ? `${label}: ${summary}` : label;
}
// `GENERIC` step text of a tool that moved to the background.
export function parseBackgroundTaskStart(content) {
  if (typeof content !== 'string') return undefined;
  const match = BACKGROUND_TASK_START.exec(content);
  if (!match) return undefined;
  const description = /\nTask Description: ([^\n]*)/.exec(content)?.[1]?.trim();
  const logUri = /\nTask logs are available at: (file:\/\/\S+)/.exec(content)?.[1];
  return {
    taskId: match[1],
    ...(description ? { description } : {}),
    ...(logUri ? { logUri } : {}),
  };
}
// `SYSTEM_MESSAGE` text agy injects when a background task ends.
export function parseBackgroundTaskFinished(content) {
  if (typeof content !== 'string' || !content.includes('finished with result:')) return undefined;
  const match = TASK_FINISHED.exec(content);
  if (!match) return undefined;
  const output = match[2].trim();
  return { taskId: match[1], output, failed: COMMAND_FAILED.test(output) };
}
function backgroundSummary(args, description) {
  const decoded = decodeSwarmArgs(args);
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const summary =
    (decoded && typeof decoded === 'object' && pick(decoded.toolSummary)) ||
    pick(description?.split('\n')[0]) ||
    (decoded && typeof decoded === 'object' && pick(decoded.CommandLine)?.split('\n')[0]);
  return summary ? truncateText(summary, BACKGROUND_SUMMARY_LIMIT) : undefined;
}
function backgroundCommand(args, description) {
  const decoded = decodeSwarmArgs(args);
  const command =
    decoded && typeof decoded === 'object' && typeof decoded.CommandLine === 'string'
      ? decoded.CommandLine
      : description;
  return typeof command === 'string' && command.trim() ? command.trim() : 'run_command';
}
const AGY_PLAN_TOOL_RE = /^(?:update_steps|todowrite|todo_write|write_todos|update_plan)$/i;

function normalizeAgyPlanStatus(raw) {
  if (typeof raw !== 'string') return 'pending';
  const s = raw.trim().toLowerCase();
  if (s === 'done' || s === 'completed') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'running' || s === 'active') {
    return 'in_progress';
  }
  return 'pending';
}

function normalizeAgyPlanPriority(raw) {
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : 'medium';
}

export function extractAgyPlanEntries(toolName, parameters) {
  if (typeof toolName !== 'string' || !AGY_PLAN_TOOL_RE.test(toolName.trim())) return null;
  const decoded = decodeSwarmArgs(parameters);
  if (!decoded || typeof decoded !== 'object') return [];
  const rawList = decoded.steps ?? decoded.todos ?? decoded.plan;
  let items = Array.isArray(rawList) ? rawList : undefined;
  if (!items && typeof rawList === 'string' && rawList.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = undefined;
    }
  }
  if (!items) return [];
  const entries = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const text =
      (typeof item.title === 'string' && item.title.trim()) ||
      (typeof item.content === 'string' && item.content.trim()) ||
      (typeof item.step === 'string' && item.step.trim()) ||
      (typeof item.description === 'string' && item.description.trim()) ||
      '';
    if (!text) continue;
    entries.push({
      content: text,
      status: normalizeAgyPlanStatus(item.status),
      priority: normalizeAgyPlanPriority(item.priority),
    });
  }
  return entries;
}

function textContent(text) {
  return [{ type: 'content', content: { type: 'text', text } }];
}
// The update that turns a tool row into a background-task row (or moves it to a new state).
export function backgroundTaskUpdate(task, state, extra = {}) {
  const title = backgroundTaskTitle(state, task.summary);
  return {
    toolCallId: task.toolCallId,
    title: task.command,
    kind: 'execute',
    status: state === 'running' ? 'in_progress' : state === 'completed' ? 'completed' : 'failed',
    rawInput: { command: task.command, description: title },
    _meta: backgroundTaskMeta(task.taskId, state),
    ...extra,
  };
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
        const text = truncateText(step.content, 16000);
        if (!summary) summary = text;
        activities.push({
          id: `resp-${stepIndex}`,
          kind: 'message',
          title: 'Yanıt',
          detail: truncateText(step.content, 360),
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
    backgroundPollMs = BACKGROUND_POLL_MS,
    listProcesses = listProcessTable,
    signalProcess = (pid, signal) => process.kill(pid, signal),
    platform = process.platform,
    taskKillGraceMs = TASK_KILL_GRACE_MS,
    // `stream-json` for direct construction (tests, embedders); serve() passes the user's choice,
    // `auto` by default: `agy acp` when the installed agy answers it (probed once, cached).
    transport = 'stream-json',
    probeTimeoutMs = ACP_PROBE_TIMEOUT_MS,
    steerAcceptTimeoutMs = STEER_ACCEPT_TIMEOUT_MS,
    acpCancelGraceMs = ACP_CANCEL_GRACE_MS,
    // agy acp: how often a built-in sub-agent's transcript is read, and how long its conversation
    // id is looked for after `invoke_subagent` returned.
    subagentPollMs = 600,
    subagentResolveMs = 20_000,
    // Where Orkestra's `run_subagent` runs keep their state files.
    subagentsStateDir = DEFAULT_SUBAGENTS_STATE_DIR,
  } = {}) {
    this.cli = cli;
    this.transport = normalizeTransport(transport);
    this.probeTimeoutMs = probeTimeoutMs;
    this.steerAcceptTimeoutMs = steerAcceptTimeoutMs;
    this.acpCancelGraceMs = acpCancelGraceMs;
    this.subagentPollMs = subagentPollMs;
    this.subagentResolveMs = subagentResolveMs;
    this.subagentsStateDir = subagentsStateDir;
    this.acpProbe = null;
    this.acpUnavailable = false;
    this.listProcesses = listProcesses;
    this.signalProcess = signalProcess;
    this.platform = platform;
    this.taskKillGraceMs = taskKillGraceMs;
    this.backgroundPollMs = backgroundPollMs;
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
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
      _meta: { steering: { supported: true } },
    };
  }
  async writeSessionAttachment(sessionId, base64Data, mimeType, uri = '') {
    const raw = typeof base64Data === 'string' ? base64Data.trim() : '';
    if (!raw) throw new Error('Ek dosya verisi boş olamaz.');
    const cleaned = raw.startsWith('data:')
      ? raw.replace(/^data:[^;,]+(?:;[^;,]+)*;base64,/i, '')
      : raw;
    const buffer = Buffer.from(cleaned, 'base64');
    const attachDir = join(this.directory, 'attachments', sessionId);
    await mkdir(attachDir, { recursive: true, mode: 0o700 });
    const ext = extensionForMime(mimeType, uri);
    const filePath = join(attachDir, `${randomUUID()}.${ext}`);
    await writeFile(filePath, buffer, { mode: 0o600 });
    return filePath;
  }
  async materializePromptBlocks(blocks, sessionId) {
    validatePromptBlocksInput(blocks, sessionId);
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        throw new Error('Geçersiz ileti içeriği bloğu.');
      }
      if (block.type === 'image') {
        const mimeType =
          typeof block.mimeType === 'string' && block.mimeType.trim()
            ? block.mimeType.trim()
            : 'image/png';
        const filePath = await this.writeSessionAttachment(sessionId, block.data, mimeType);
        parts.push(
          `\n[Kullanıcı görsel ekledi: ${filePath} (MIME: ${mimeType}). Görseli incelemek için read_file aracını bu tam dosya yoluyla kullan.]`
        );
        continue;
      }
      if (
        block.type === 'resource' &&
        block.resource &&
        typeof block.resource === 'object' &&
        typeof block.resource.text !== 'string' &&
        typeof block.resource.blob === 'string' &&
        block.resource.blob.length > 0
      ) {
        const resource = block.resource;
        const mimeType =
          typeof resource.mimeType === 'string' && resource.mimeType.trim()
            ? resource.mimeType.trim()
            : 'application/octet-stream';
        const uri = typeof resource.uri === 'string' ? resource.uri.trim() : '';
        const filePath = await this.writeSessionAttachment(sessionId, resource.blob, mimeType, uri);
        parts.push(
          `\n[Kullanıcı dosya ekledi: ${filePath} (${uri ? `URI: ${uri}, ` : ''}MIME: ${mimeType}). Dosyayı incelemek için read_file aracını bu tam dosya yoluyla kullan.]`
        );
        continue;
      }
      parts.push(materializeSyncBlock(block));
    }
    return parts.join('\n');
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
  // One `invoke_subagent` card of the replayed history, with the sub-agent's real end. One still
  // running in a live agy process stays live; otherwise an unfinished one ends "outcome unknown".
  async replayAgySubagent(sessionId, parentId, entry, content, liveProc, live) {
    const created = parseCreatedSubagent(content);
    this.emitAgySubagent(sessionId, entry, 'in_progress');
    if (!created) {
      entry.lastStatus = 'failed';
      this.emitAgySubagent(sessionId, entry, 'failed', {
        summary: replayOutput(content) || 'Alt ajan başlatılamadı.',
      });
      return;
    }
    entry.conversationId = created.conversationId;
    entry.outputFile = join(
      this.brainDirectory,
      created.conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    const { status, ...extra } = await this.readAgySubagentState(parentId, entry, new Set());
    if (status === 'in_progress' && live) {
      liveProc.agySubagents ??= new Map();
      liveProc.agySubagents.set(entry.rowId, entry);
      this.emitAgySubagent(sessionId, entry, status, extra);
      this.startAgySubagentWatcher(sessionId, liveProc, { nativeId: parentId }, entry);
      return;
    }
    entry.lastStatus = status === 'in_progress' ? 'completed' : status;
    this.emitAgySubagent(
      sessionId,
      entry,
      entry.lastStatus,
      status === 'in_progress' ? { ...extra, statusUnknown: true } : extra
    );
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
      // A live agy process for this session keeps syncing its swarm; replayed members it still
      // runs stay live rows. Otherwise nothing follows them after the replay.
      const liveProc = this.processes.get(sessionId);
      const live = Boolean(liveProc && !liveProc.closed && !liveProc.discarded);
      if (!live) this.swarms.delete(sessionId);
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
      // agy's built-in sub-agents become cards with their real end (standard models; orchestrator
      // conversations replay exactly as before).
      const agyCards = !isOrchestratorModel(this.sessions.get(sessionId)?.model);
      const agySubs = new Map(); // toolCallId -> invoke_subagent card
      const finishedTasks = new Map(); // background task id -> how it ended
      for (const line of lines) {
        if (!line.includes('finished with result:')) continue;
        try {
          const row = JSON.parse(line);
          const finished =
            row?.type === 'SYSTEM_MESSAGE' && parseBackgroundTaskFinished(row.content);
          if (finished) finishedTasks.set(finished.taskId, finished);
        } catch {
          /* skip damaged lines */
        }
      }
      const flush = () => {
        for (const call of pending) {
          const agySub = agySubs.get(call.toolCallId);
          if (agySub) {
            // agy stopped before the sub-agent was created: how it ended is unknown.
            this.emitAgySubagent(sessionId, agySub, 'in_progress');
            this.emitAgySubagent(sessionId, agySub, 'completed', { statusUnknown: true });
            continue;
          }
          const extSub = extSubs.get(call.toolCallId);
          if (extSub) {
            // The call never returned (agy stopped first): the run's end is unknown. Plain row,
            // no agent registration, so it can neither claim "done" nor keep the session busy.
            this.update(sessionId, {
              ...call,
              status: 'completed',
              _meta: UNKNOWN_SUBAGENT_TOOL_META,
            });
            continue;
          }
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
          const start =
            row.status === 'RUNNING' ? parseBackgroundTaskStart(row.content) : undefined;
          if (start) {
            // A background task: its end is a later SYSTEM_MESSAGE, or nothing if agy stopped.
            const finished = finishedTasks.get(start.taskId);
            const task = {
              toolCallId: call.toolCallId,
              taskId: start.taskId,
              command: backgroundCommand(call.rawInput, start.description),
              summary: backgroundSummary(call.rawInput, start.description),
            };
            const state = finished ? (finished.failed ? 'failed' : 'completed') : 'stopped';
            const text = finished ? replayOutput(finished.output) : BACKGROUND_STOPPED_NOTES.replay;
            this.update(sessionId, {
              sessionUpdate: 'tool_call',
              ...backgroundTaskUpdate(task, state, {
                ...(finished && text ? { rawOutput: text } : {}),
                ...(text ? { content: textContent(text) } : {}),
              }),
            });
            continue;
          }
          const agySub = agySubs.get(call.toolCallId);
          if (agySub) {
            await this.replayAgySubagent(sessionId, nativeId, agySub, row.content, liveProc, live);
            continue;
          }
          const output = replayOutput(row.content);
          const member = members.get(call.toolCallId);
          if (member) {
            const failed = swarmAddFailed(row.content, false);
            this.update(sessionId, {
              ...call,
              status: failed ? 'failed' : 'in_progress',
              ...(output === undefined ? {} : { rawOutput: output }),
              ...(live && !failed ? { _meta: DETACHED_SUBAGENT_TOOL_META } : {}),
            });
            if (!failed)
              this.swarmMembers(sessionId).set(member.member, {
                toolCallId: call.toolCallId,
                afterSeq: swarmBriefSeq(row.content),
                replayed: !live,
                needsBrief: member.truncatedBrief,
                sent: 'in_progress|',
              });
            continue;
          }
          const extSub = extSubs.get(call.toolCallId);
          if (extSub) {
            const rawReplayText =
              typeof row.content === 'string'
                ? row.content.replace(/^(?:Created At|Completed At): [^\n]*\n/gm, '').trim()
                : undefined;
            const parsedOut = parseExternalSubagentOutput(rawReplayText ?? output);
            const failed =
              (parsedOut && parsedOut.ok === false) ||
              /^permission check failed/i.test(row.content ?? '') ||
              /Encountered error in step execution/i.test(row.content ?? '') ||
              /^Command exited with code [1-9]\d*/m.test(row.content ?? '');
            const status = failed ? 'failed' : 'completed';
            const summary =
              parsedOut?.error ||
              (typeof parsedOut?.response === 'string' && parsedOut.response.trim()
                ? truncateText(parsedOut.response, 16000)
                : undefined);
            const provider = parsedOut?.provider || extSub.provider;
            const model =
              parsedOut?.model ||
              (extSub.model
                ? formatModelDisplayName(String(extSub.model)) || extSub.model
                : undefined);
            const effort =
              parsedOut?.effort ||
              (typeof extSub.effort === 'string' && extSub.effort.trim()
                ? extSub.effort.trim().toLowerCase()
                : extractEffortFromModel(
                    typeof extSub.model === 'string' ? extSub.model : undefined
                  ));
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
                  ...(Array.isArray(parsedOut?.activities)
                    ? { activities: parsedOut.activities }
                    : {}),
                  background: true,
                  status,
                },
              },
            });
            // A run stopped from its card comes back "stopped" (standard models; the run's state
            // file says so).
            if (agyCards && status === 'failed' && UUID.test(parsedOut?.runId ?? '')) {
              try {
                const saved = JSON.parse(
                  await readFile(join(this.subagentsStateDir, `${parsedOut.runId}.json`), 'utf8')
                );
                if (saved?.cancelled === true)
                  this.update(sessionId, {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: call.toolCallId,
                    status,
                    _meta: {
                      antigravity: {
                        kind: 'subagent_update',
                        toolCallId: call.toolCallId,
                        agentId: parsedOut.runId,
                        status,
                        ...(summary ? { summary } : {}),
                        interrupted: true,
                      },
                    },
                  });
              } catch {
                /* no state file: the run's own answer stands */
              }
            }
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
          const content = await rebuildAntigravityUserChunk(
            replayUserText(row.content),
            this.directory,
            sessionId
          );
          if (!content) continue;
          begin();
          send('user_message_chunk', content, ts);
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
              if (agyCards && tool.name === 'invoke_subagent') {
                const args = tool.args && typeof tool.args === 'object' ? tool.args : {};
                const arg = (key) => unwrapQuotedString(args[key] ?? '').trim();
                agySubs.set(toolCallId, {
                  acpId: null,
                  rowId: toolCallId,
                  title: arg('Role') || 'Alt Ajan',
                  role: arg('TypeName') || undefined,
                  prompt: arg('Prompt') || undefined,
                  conversationId: null,
                  outputFile: undefined,
                  lastStatus: 'in_progress',
                  emitted: false,
                  resolving: true,
                });
                pending.push({ sessionUpdate: 'tool_call', toolCallId });
                return;
              }
              const planEntries = extractAgyPlanEntries(tool.name, tool.args);
              if (planEntries !== null) {
                if (planEntries.length > 0) {
                  pending.push({ sessionUpdate: 'plan', entries: planEntries });
                }
                return;
              }
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
                ...(swarm?.meta ? { _meta: swarm.meta } : {}),
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
          const entries = await readdir(this.subagentsStateDir);
          let bestPath = null;
          let bestStarted = 0;
          for (const entry of entries) {
            if (!entry.endsWith('.json')) continue;
            const full = join(this.subagentsStateDir, entry);
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
                ...(proc.transport === 'acp' && data.cancelled === true && data.status === 'failed'
                  ? { interrupted: true }
                  : {}),
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
  emitAgentText(sessionId, proc, stepIndex, text) {
    if (
      proc.lastResponseStepIndex !== null &&
      proc.lastResponseStepIndex !== stepIndex &&
      !proc.lastResponseEndedWithNewline &&
      !text.startsWith('\n')
    ) {
      this.update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\n' },
      });
    }
    proc.lastResponseStepIndex = stepIndex ?? proc.lastResponseStepIndex;
    proc.lastResponseEndedWithNewline = text.endsWith('\n');
    if (proc.currentTurn) proc.currentTurn.emitted = true;
    this.update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }
  transcriptPath(nativeId) {
    return typeof nativeId === 'string' && UUID.test(nativeId)
      ? join(this.brainDirectory, nativeId, '.system_generated', 'logs', 'transcript.jsonl')
      : null;
  }
  // Where this turn's transcript rows start: everything before belongs to earlier turns.
  async transcriptStart(nativeId) {
    const path = this.transcriptPath(nativeId);
    if (!path) return { path: null, offset: 0 };
    try {
      return { path, offset: (await stat(path)).size };
    } catch {
      return { path, offset: 0 };
    }
  }
  // A task log is read only from this conversation's own task directory.
  taskLogPath(nativeId, logUri, taskId) {
    if (typeof nativeId !== 'string' || !UUID.test(nativeId)) return undefined;
    const tasksDir = join(this.brainDirectory, nativeId, '.system_generated', 'tasks');
    const fromUri = filePathFromUri(logUri);
    if (
      fromUri &&
      fromUri.startsWith(tasksDir + sep) &&
      !fromUri.slice(tasksDir.length).includes('..')
    )
      return fromUri;
    const name = typeof taskId === 'string' ? taskId.split('/').pop() : '';
    return /^task-\d+$/.test(name) ? join(tasksDir, `${name}.log`) : undefined;
  }
  startBackgroundWatch(sessionId, proc, s) {
    if (proc.backgroundTimer || proc.closed || proc.discarded || !proc.transcript) return;
    proc.backgroundTimer = setInterval(
      () => void this.pollBackground(sessionId, proc, s),
      this.backgroundPollMs
    );
    proc.backgroundTimer.unref?.();
  }
  stopBackgroundWatchIfIdle(proc) {
    if (proc.activeTools.size > 0 || !proc.backgroundTimer) return;
    clearInterval(proc.backgroundTimer);
    proc.backgroundTimer = null;
  }
  // Closes this turn's background rows. `reason` null: the turn ended normally (agy only ends a
  // turn after its non-daemon background tasks), so nothing is left to report.
  endBackgroundTracking(sessionId, proc, reason) {
    if (reason) {
      const base = BACKGROUND_STOPPED_NOTES[reason] ?? BACKGROUND_STOPPED_NOTES.lost;
      for (const task of proc.backgroundTasks.values()) {
        const note = task.terminated ? BACKGROUND_STOPPED_NOTES.terminated : base;
        const text = task.tail ? `${task.tail}\n\n${note}` : note;
        this.update(sessionId, {
          sessionUpdate: 'tool_call_update',
          ...backgroundTaskUpdate(task, 'stopped', { content: textContent(text) }),
        });
      }
      // agy never closes a tool step it was running when the turn was interrupted.
      for (const id of proc.activeTools.keys()) {
        if (!proc.backgroundTasks.has(id))
          this.update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: id,
            status: 'failed',
          });
      }
    }
    proc.backgroundTasks.clear();
    proc.activeTools.clear();
    proc.mirroredSteps.clear();
    if (proc.backgroundTimer) clearInterval(proc.backgroundTimer);
    proc.backgroundTimer = null;
  }
  async findTaskProcesses(proc) {
    const agyPid = proc.child?.pid;
    if (!proc.backgroundTasks.size || !Number.isInteger(agyPid)) return undefined;
    if (!TASK_KILL_PLATFORMS.has(this.platform)) return undefined;
    let table;
    try {
      table = await this.listProcesses();
    } catch {
      return undefined;
    }
    const owned = ownedTaskProcesses(table, agyPid, [...proc.backgroundTasks.values()]);
    if (!owned.trees.length) return undefined;
    for (const task of owned.tasks) task.terminated = true;
    return owned;
  }
  // SIGTERM now; SIGKILL after a grace period, only to processes that are still the same ones.
  terminateTaskProcesses(trees) {
    const send = (pid, signal) => {
      try {
        this.signalProcess(pid, signal);
      } catch {
        /* already gone */
      }
    };
    for (const tree of trees) {
      for (const member of tree.members) send(member.pid, 'SIGTERM');
      if (tree.group) send(-tree.group, 'SIGTERM');
    }
    const timer = setTimeout(async () => {
      let table;
      try {
        table = await this.listProcesses();
      } catch {
        return;
      }
      for (const tree of trees) {
        for (const member of tree.members) {
          const still = table.find((row) => row.pid === member.pid);
          if (still && still.args === member.args && still.pgid === member.pgid)
            send(member.pid, 'SIGKILL');
        }
        if (tree.group && table.some((row) => row.pgid === tree.group))
          send(-tree.group, 'SIGKILL');
      }
    }, this.taskKillGraceMs);
    timer.unref?.();
  }
  backgroundStopReason() {
    // Steering never stops a turn (see steerSession), so a cancelled turn here was stopped by the
    // user.
    return 'cancelled';
  }
  async pollBackground(sessionId, proc, s) {
    if (proc.backgroundPolling || proc.closed || proc.discarded) return;
    proc.backgroundPolling = true;
    try {
      await this.readTranscriptAppend(sessionId, proc, s);
      for (const task of [...proc.backgroundTasks.values()]) {
        await this.tailTaskLog(sessionId, proc, task);
      }
    } catch {
      /* Background mirroring is best effort; the stream still closes the rows. */
    } finally {
      proc.backgroundPolling = false;
    }
  }
  async readTranscriptAppend(sessionId, proc, s) {
    const cursor = proc.transcript;
    if (!cursor) return;
    await cursor.ready;
    if (!cursor.path) {
      // A new conversation: its transcript exists only after agy announced the id.
      cursor.path = this.transcriptPath(s.nativeId);
      cursor.offset = 0;
      if (!cursor.path) return;
    }
    let size;
    try {
      size = (await stat(cursor.path)).size;
    } catch {
      return;
    }
    if (size < cursor.offset) {
      // Rewritten file: never re-read older history as if it were new.
      cursor.offset = size;
      cursor.remainder = '';
      return;
    }
    if (size === cursor.offset) return;
    const handle = await open(cursor.path, 'r');
    let chunk;
    try {
      const length = Math.min(size - cursor.offset, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      cursor.offset += bytesRead;
      chunk = cursor.decoder.write(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    const lines = (cursor.remainder + chunk).split('\n');
    cursor.remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (proc.closed || proc.discarded || proc.currentTurn === null) return;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row && typeof row === 'object') this.handleTranscriptRow(sessionId, proc, s, row);
    }
  }
  handleTranscriptRow(sessionId, proc, s, row) {
    const cursor = proc.transcript;
    const step = Number(row.step_index);
    if (row.type === 'PLANNER_RESPONSE') {
      if (Array.isArray(row.tool_calls)) cursor.pendingCalls.push(...row.tool_calls);
      const truncated =
        Array.isArray(row.truncated_fields) && row.truncated_fields.includes('content');
      // Only a reply the stream is holding back behind a running background task (the ACP
      // transport streams every reply live).
      if (
        proc.transport !== 'acp' &&
        proc.backgroundTasks.size > 0 &&
        typeof row.content === 'string' &&
        row.content.trim() &&
        !truncated &&
        Number.isInteger(step) &&
        step > proc.maxStreamStep &&
        !proc.mirroredSteps.has(step)
      ) {
        proc.mirroredSteps.add(step);
        this.emitAgentText(sessionId, proc, step, row.content);
      }
      return;
    }
    if (row.type !== 'GENERIC') return;
    const call = cursor.pendingCalls.shift();
    if (row.status !== 'RUNNING' || !Number.isInteger(step)) return;
    const start = parseBackgroundTaskStart(row.content);
    if (!start) return;
    // The stream's row for the same step; a task that already ended stays as it is. ACP tool ids
    // carry no step index: the running row is the one tool running exactly this command.
    const toolCallId =
      proc.transport === 'acp'
        ? acpToolForCommand(proc, backgroundCommand(call?.args, start.description))
        : 'agy-' + step;
    if (!toolCallId || !proc.activeTools.has(toolCallId) || proc.backgroundTasks.has(toolCallId))
      return;
    const task = {
      toolCallId,
      taskId: start.taskId,
      command: backgroundCommand(call?.args, start.description),
      summary: backgroundSummary(call?.args, start.description),
      logFile: this.taskLogPath(s.nativeId, start.logUri, start.taskId),
      tail: '',
    };
    proc.backgroundTasks.set(toolCallId, task);
    this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      ...backgroundTaskUpdate(task, 'running'),
    });
  }
  async tailTaskLog(sessionId, proc, task) {
    if (!task.logFile) return;
    let handle;
    try {
      handle = await open(task.logFile, 'r');
    } catch {
      return;
    }
    let text;
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, BACKGROUND_LOG_TAIL_BYTES);
      if (!length) return;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      text = buffer.subarray(0, bytesRead).toString('utf8');
      if (size > length) text = '…' + text.slice(text.indexOf('\n') + 1);
    } finally {
      await handle.close();
    }
    text = text.replace(/\s+$/, '');
    // The row may have been closed while the log was being read.
    if (!text || text === task.tail || proc.backgroundTasks.get(task.toolCallId) !== task) return;
    task.tail = text;
    this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: task.toolCallId,
      content: textContent(text),
    });
  }
  // One stream-json `step_update` (also the ACP transport's tool updates, converted by
  // `acpToolStep`): tool, sub-agent and background rows, and agent text.
  handleStepUpdate(sessionId, proc, s, u) {
    const stepIndex = Number(u.step_index);
    if (Number.isInteger(stepIndex) && stepIndex > proc.maxStreamStep)
      proc.maxStreamStep = stepIndex;
    // A reply already shown from the transcript while the stream held it back.
    if (u.step_type === 'agent_response' && u.text_delta && proc.mirroredSteps.has(stepIndex)) {
      if (proc.currentTurn) proc.currentTurn.emitted = true;
    } else if (u.step_type === 'agent_response' && u.text_delta) {
      this.emitAgentText(sessionId, proc, u.step_index, u.text_delta);
    }
    if (u.step_type === 'tool') {
      const planEntries = extractAgyPlanEntries(u.tool_name, u.tool_info?.parameters);
      if (planEntries !== null) {
        if (planEntries.length > 0) {
          this.update(sessionId, { sessionUpdate: 'plan', entries: planEntries });
        }
        return;
      }
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
            : extractEffortFromModel(typeof extSub.model === 'string' ? extSub.model : undefined));
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
            ? truncateText(parsedOut.response, 16000)
            : undefined);
        const activities = Array.isArray(parsedOut?.activities) ? parsedOut.activities : undefined;
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
              ...(activities ? { activities } : {}),
              background: true,
              status: finalStatus,
            },
          },
        });
        if (
          u.state === 'DONE' &&
          typeof u.tool_info?.error === 'string' &&
          /permission check failed|user denied permission/i.test(u.tool_info.error) &&
          proc.currentTurn
        ) {
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
          const runFile = join(this.subagentsStateDir, `${parsedOut.runId}.json`);
          void readFile(runFile, 'utf8')
            .then((raw) => {
              const saved = JSON.parse(raw);
              // agy acp: a run stopped from its card ends "stopped", not as an error.
              const interrupted =
                proc.transport === 'acp' && saved.cancelled === true && finalStatus === 'failed';
              if ((Array.isArray(saved.activities) && saved.activities.length > 0) || interrupted) {
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
                      ...(Array.isArray(saved.activities) ? { activities: saved.activities } : {}),
                      ...(interrupted ? { interrupted: true } : {}),
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
        if (doneFlag) proc.activeTools.delete(id);
        else {
          proc.activeTools.set(id, {
            stepIndex,
            name: u.tool_name,
            command: backgroundCommand(u.tool_info?.parameters),
          });
          this.startBackgroundWatch(sessionId, proc, s);
        }
        const backgroundTask = proc.backgroundTasks.get(id);
        if (backgroundTask && doneFlag) {
          // The background task ended: keep the row an execute row and close it.
          proc.backgroundTasks.delete(id);
          const output = typeof u.tool_info?.output === 'string' ? u.tool_info.output : undefined;
          const failed =
            Boolean(u.tool_info?.error) || (output !== undefined && COMMAND_FAILED.test(output));
          this.update(sessionId, {
            sessionUpdate: 'tool_call_update',
            ...backgroundTaskUpdate(backgroundTask, failed ? 'failed' : 'completed', {
              rawOutput: u.tool_info?.output,
              ...(output ? { content: textContent(output) } : {}),
            }),
          });
          this.stopBackgroundWatchIfIdle(proc);
          return;
        }
        if (backgroundTask) return; // still running; the background row stays as it is
        const data = {
          sessionUpdate: known ? 'tool_call_update' : 'tool_call',
          toolCallId: id,
          title: swarm?.title ?? u.display_title ?? (u.tool_name || 'Araç'),
          kind: swarm?.kind ?? 'other',
          status,
          rawInput: swarm ? swarm.rawInput : u.tool_info?.parameters,
          rawOutput: u.tool_info?.output,
          ...(swarm?.member
            ? {
                _meta: {
                  ...swarm.meta,
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
        if (doneFlag && SWARM_SYNC_TOOLS.has(u.tool_name)) this.syncSwarm(sessionId, s.nativeId);
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
      discarded: false,
      // Background-task tracking (see BACKGROUND_POLL_MS).
      activeTools: new Map(), // toolCallId -> { stepIndex, name }
      backgroundTasks: new Map(), // toolCallId -> { toolCallId, taskId, command, summary, logFile, tail }
      maxStreamStep: -1,
      mirroredSteps: new Set(),
      transcript: null, // { path, offset, remainder, pendingCalls }
      backgroundTimer: null,
      backgroundPolling: false,
    };
    this.processes.set(sessionId, proc);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (proc.discarded) return;
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('Antigravity yanıt satırı çok büyük.');
        const event = JSON.parse(line);
        if (event.event === 'init' && event.conversation_id) {
          s.nativeId = event.conversation_id;
          void this.save(sessionId, s).catch(() => {});
        }
        if (event.event === 'step_update')
          this.handleStepUpdate(sessionId, proc, s, event.step_update);
        if (event.event === 'result') {
          const final = event.result;
          if (final?.conversation_id) {
            s.nativeId = final.conversation_id;
          }
          const turn = proc.currentTurn;
          if (turn) {
            const ended = turn.cancelled
              ? this.backgroundStopReason()
              : final?.status === 'SUCCESS'
                ? null
                : 'error';
            this.endBackgroundTracking(sessionId, proc, ended);
            proc.currentTurn = null;
            if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
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
      this.endBackgroundTracking(sessionId, proc, proc.currentTurn ? 'lost' : null);
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      const turn = proc.currentTurn;
      proc.currentTurn = null;
      // A replacement process may already own the session's active turn.
      if (turn && this.active.get(sessionId) === turn) this.active.delete(sessionId);
      finish();
      if (turn) turn.reject(error);
    });
    child.on('close', async (code) => {
      proc.closed = true;
      clearTimeout(proc.timer);
      this.stopAllSubagentWatchers(proc);
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      const turn = proc.currentTurn;
      // Rows of an open turn must not stay "running" (or be closed as done) after agy is gone.
      if (turn && !proc.discarded)
        this.endBackgroundTracking(
          sessionId,
          proc,
          turn.cancelled ? this.backgroundStopReason() : 'lost'
        );
      else this.endBackgroundTracking(sessionId, proc, null);
      proc.currentTurn = null;
      if (turn && this.active.get(sessionId) === turn) this.active.delete(sessionId);
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
    const s = this.session(p.sessionId);
    if (this.active.has(p.sessionId)) throw new Error('Bu oturumda zaten bir yanıt hazırlanıyor.');
    let resolveTurn;
    let rejectTurn;
    const turnPromise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn = {
      resolve: resolveTurn,
      reject: rejectTurn,
      emitted: false,
      cancelled: false,
      deniedTools: [],
      child: null,
      done: Promise.resolve(),
    };
    this.active.set(p.sessionId, turn);
    try {
      validatePromptBlocksInput(p.prompt, p.sessionId);
      const text = needsAsyncMaterialization(p.prompt)
        ? await this.materializePromptBlocks(p.prompt, p.sessionId)
        : p.prompt.map(materializeSyncBlock).join('\n');
      if (turn.cancelled) {
        if (this.active.get(p.sessionId) === turn) this.active.delete(p.sessionId);
        return { stopReason: 'cancelled' };
      }
      if (s.mcpServers && Object.keys(s.mcpServers).length > 0) {
        await this.materializeMcpServers(s);
      }
      const live = this.refreshOrchestratorConfig();
      if (live) {
        if (live.settings) s.orchestrator = { ...live.settings };
        else delete s.orchestrator;
      }
      // Decided without waiting unless agy acp support is still being probed, so a stream-json turn
      // starts its process in the same tick as before.
      const transport = this.knownTransport(s) ?? (await this.resolveTransport(s));
      const existing = this.processes.get(p.sessionId);
      if (
        existing &&
        (existing.model !== s.model ||
          existing.mode !== s.mode ||
          existing.orchestratorKey !== orchestratorKey(s.orchestrator) ||
          (existing.transport ?? 'stream-json') !== transport)
      ) {
        await this.terminateProcess(p.sessionId);
      } else if (existing && existing.closing && !existing.closed) {
        // A cancelled or discarded process must finish closing before its replacement starts,
        // so its close cannot be mistaken for the new turn's.
        await existing.done;
      }
      if (turn.cancelled) {
        if (this.active.get(p.sessionId) === turn) this.active.delete(p.sessionId);
        return { stopReason: 'cancelled' };
      }
      if (transport === 'acp') {
        // null: agy acp could not be started or attached; this turn runs on stream-json.
        const acpProc = await this.tryAcpProcess(p.sessionId, s);
        if (turn.cancelled) {
          if (this.active.get(p.sessionId) === turn) this.active.delete(p.sessionId);
          return { stopReason: 'cancelled' };
        }
        if (acpProc) {
          this.startAcpTurn(p.sessionId, s, acpProc, turn, text);
          return await turnPromise;
        }
      }
      const proc = this.ensureProcess(p.sessionId, s);
      turn.child = proc.child;
      turn.done = proc.done;
      proc.currentTurn = turn;
      // Measured without delaying the prompt; agy writes its first row long after this resolves.
      const cursor = {
        path: this.transcriptPath(s.nativeId),
        offset: null,
        remainder: '',
        decoder: new StringDecoder('utf8'),
        pendingCalls: [],
      };
      cursor.ready = this.transcriptStart(s.nativeId).then(({ offset }) => {
        cursor.offset = offset;
      });
      proc.transcript = cursor;
      proc.lastResponseStepIndex = null;
      proc.lastResponseEndedWithNewline = true;
      proc.child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
      return await turnPromise;
    } catch (error) {
      if (this.active.get(p.sessionId) === turn) this.active.delete(p.sessionId);
      throw error;
    }
  }
  // --- agy acp transport ------------------------------------------------------------------------
  // Which transport a turn of this session uses. A session that needs something only stream-json
  // can do (see streamJsonOnlyReason) always runs there and keeps queueing mid-turn messages.
  knownTransport(s) {
    if (streamJsonOnlyReason(s, { isOrchestratorModel })) return 'stream-json';
    if (this.transport === 'stream-json' || this.acpUnavailable) return 'stream-json';
    if (this.transport === 'acp') return 'acp';
    return null;
  }
  async resolveTransport(s) {
    return this.knownTransport(s) ?? ((await this.probeAcp()) ? 'acp' : 'stream-json');
  }
  // Probed once per agy binary on this host: the result is cached next to the session files and
  // reused until the binary changes (size or mtime).
  probeAcp() {
    if (!this.acpProbe) this.acpProbe = this.runAcpProbe();
    return this.acpProbe;
  }
  acpProbeCachePath() {
    return join(this.directory, 'agy-acp-probe.json');
  }
  async acpFingerprint() {
    if (typeof this.cli !== 'string' || !isAbsolute(this.cli)) return undefined;
    try {
      const info = await stat(this.cli);
      return `${this.cli}|${info.size}|${Math.trunc(info.mtimeMs)}`;
    } catch {
      return undefined;
    }
  }
  async runAcpProbe() {
    const fingerprint = await this.acpFingerprint();
    if (fingerprint) {
      try {
        const cached = JSON.parse(await readFile(this.acpProbeCachePath(), 'utf8'));
        if (cached?.fingerprint === fingerprint && typeof cached.supported === 'boolean')
          return cached.supported;
      } catch {
        /* no cache yet */
      }
    }
    const supported = await probeAgyAcp({
      cli: this.cli,
      spawnProcess: this.spawnProcess,
      timeoutMs: this.probeTimeoutMs,
    });
    if (fingerprint) {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = this.acpProbeCachePath(),
          temp = path + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify({ fingerprint, supported, checkedAt: Date.now() }), {
          mode: 0o600,
        });
        await rename(temp, path);
      } catch {
        /* the in-memory result still holds for this process */
      }
    }
    return supported;
  }
  // agy acp did not start or answer `initialize`: this adapter process uses stream-json from now
  // on, and the next one probes again.
  async markAcpUnavailable() {
    this.acpUnavailable = true;
    this.acpProbe = Promise.resolve(false);
    try {
      await writeFile(this.acpProbeCachePath(), '{}', { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
  // Settings agy reads from `--settings` (placed before `acp`): the session's own settings and the
  // auto-approval of the app's MCP tools. The approval is also given per request (see
  // handleAcpRequest), since it is not verified that `agy acp` applies `--settings`.
  acpSettings(s) {
    const args = buildArgs({ ...s, nativeId: undefined, orchestrator: undefined });
    const at = args.indexOf('--settings');
    if (at < 0) return undefined;
    try {
      return JSON.parse(args[at + 1]);
    } catch {
      return undefined;
    }
  }
  // An attached agy acp process for this session, or null when this turn must fall back to
  // stream-json. Never throws.
  async tryAcpProcess(sessionId, s) {
    try {
      return await this.ensureAcpProcess(sessionId, s);
    } catch (error) {
      if (error?.acpStage === 'initialize') await this.markAcpUnavailable();
      return null;
    }
  }
  async ensureAcpProcess(sessionId, s) {
    const key = orchestratorKey(s.orchestrator);
    const existing = this.processes.get(sessionId);
    if (
      existing &&
      existing.transport === 'acp' &&
      existing.ready &&
      !existing.closed &&
      !existing.closing &&
      existing.model === s.model &&
      existing.mode === s.mode &&
      existing.orchestratorKey === key
    )
      return existing;
    if (existing) await this.terminateProcess(sessionId);
    const child = this.spawnProcess(this.cli, buildAcpArgs(s, this.acpSettings(s)), {
      cwd: s.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const proc = {
      transport: 'acp',
      child,
      model: s.model,
      mode: s.mode,
      orchestratorKey: key,
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
      discarded: false,
      activeTools: new Map(),
      backgroundTasks: new Map(),
      maxStreamStep: -1,
      mirroredSteps: new Set(),
      transcript: null,
      backgroundTimer: null,
      backgroundPolling: false,
      conn: null,
      childSessionId: null,
      // History agy replays while attaching belongs to earlier turns (replayHistory shows it).
      attaching: true,
      ready: false,
      detached: false,
      acpTools: new Map(), // ACP toolCallId -> { key, name, args, status }
      acpToolSeq: 0,
      acpTextKey: 0,
      agySubagents: new Map(), // ACP toolCallId of invoke_subagent -> card state
      agySubagentDenied: new Map(), // sub-agent conversation id -> tool refused by the mode
    };
    this.processes.set(sessionId, proc);
    proc.conn = new AcpChildConnection(child, {
      onNotification: (method, params) =>
        this.handleAcpNotification(sessionId, proc, s, method, params),
      onRequest: (method, params) => this.handleAcpRequest(sessionId, proc, s, method, params),
    });
    child.on('error', (error) => this.acpProcessGone(sessionId, proc, error));
    child.on('close', (code) => this.acpProcessGone(sessionId, proc, null, code));
    const stage = async (name, run) => {
      try {
        return await run();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.acpStage = name;
        throw failure;
      }
    };
    try {
      const init = await stage('initialize', () =>
        proc.conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'orkestra-antigravity', version: '1.0.0' },
        })
      );
      const caps =
        init?.agentCapabilities?.sessionCapabilities ??
        init?.agentCapabilities?.session_capabilities ??
        {};
      if (s.nativeId) {
        const params = { sessionId: s.nativeId, cwd: s.cwd, mcpServers: [] };
        let attached = false;
        if (caps.resume) {
          try {
            await proc.conn.request('session/resume', params);
            attached = true;
          } catch {
            /* fall back to session/load (its history replay is dropped while attaching) */
          }
        }
        if (!attached) await stage('session', () => proc.conn.request('session/load', params));
        proc.childSessionId = s.nativeId;
      } else {
        const created = await stage('session', () =>
          proc.conn.request('session/new', { cwd: s.cwd, mcpServers: [] })
        );
        if (typeof created?.sessionId !== 'string' || !UUID.test(created.sessionId))
          throw Object.assign(new Error('agy acp oturum kimliği vermedi.'), {
            acpStage: 'session',
          });
        proc.childSessionId = created.sessionId;
        s.nativeId = created.sessionId;
        await this.save(sessionId, s);
      }
      await stage('session', () =>
        proc.conn.request('session/set_model', { sessionId: proc.childSessionId, modelId: s.model })
      );
      if (s.mode !== 'auto')
        await stage('session', () =>
          proc.conn.request('session/set_mode', {
            sessionId: proc.childSessionId,
            modeId: s.mode === 'plan' ? 'plan' : 'default',
          })
        );
    } catch (error) {
      proc.closing = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
      throw error;
    }
    proc.attaching = false;
    proc.ready = true;
    return proc;
  }
  startAcpTurn(sessionId, s, proc, turn, text) {
    turn.child = proc.child;
    turn.done = proc.done;
    turn.session = s;
    turn.chain = [];
    turn.finished = false;
    proc.currentTurn = turn;
    const cursor = {
      path: this.transcriptPath(s.nativeId),
      offset: null,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      pendingCalls: [],
    };
    cursor.ready = this.transcriptStart(s.nativeId).then(({ offset }) => {
      cursor.offset = offset;
    });
    proc.transcript = cursor;
    proc.lastResponseStepIndex = null;
    proc.lastResponseEndedWithNewline = true;
    this.sendAcpPrompt(sessionId, proc, turn, text, false);
  }
  // One `session/prompt` of a turn's chain. The user-visible turn spans the whole chain: agy
  // answers an earlier prompt with `end_turn` as soon as a later one joins the running turn, so the
  // turn ends only when every prompt of the chain has returned.
  sendAcpPrompt(sessionId, proc, turn, text, steer) {
    let settle;
    const entry = {
      steer,
      settled: false,
      accepted: !steer,
      rejected: false,
      result: undefined,
      error: undefined,
    };
    entry.settledPromise = new Promise((resolve) => {
      settle = resolve;
    });
    turn.chain.push(entry);
    proc.conn
      .request('session/prompt', {
        sessionId: proc.childSessionId,
        prompt: [{ type: 'text', text }],
      })
      .then(
        (result) => {
          entry.result = result;
        },
        (error) => {
          entry.error = error;
        }
      )
      .finally(() => {
        entry.settled = true;
        // A steered message agy refused before taking it never joined the turn.
        if (entry.steer && entry.error && !entry.accepted) entry.rejected = true;
        settle();
        this.maybeFinishAcpTurn(sessionId, proc, turn);
      });
    return entry;
  }
  maybeFinishAcpTurn(sessionId, proc, turn) {
    if (turn.finished || turn.chain.some((entry) => !entry.settled)) return;
    turn.finished = true;
    clearTimeout(turn.cancelTimer);
    const final =
      [...turn.chain].reverse().find((entry) => !entry.rejected) ??
      turn.chain[turn.chain.length - 1];
    const stopReason = final?.result?.stopReason;
    const cancelled = turn.cancelled || stopReason === 'cancelled';
    const failed = !cancelled && Boolean(final?.error);
    this.endBackgroundTracking(
      sessionId,
      proc,
      cancelled ? this.backgroundStopReason() : failed ? (proc.closed ? 'lost' : 'error') : null
    );
    // Rows of this turn are final; agy may still repeat the end of a cancelled tool afterwards.
    for (const known of proc.acpTools.values()) known.closed = true;
    if (proc.currentTurn === turn) proc.currentTurn = null;
    if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
    const s = turn.session;
    void (async () => {
      try {
        if (s) {
          await this.save(sessionId, s);
          await this.syncSwarm(sessionId, s.nativeId);
        }
      } catch {
        /* ignore */
      }
      if (cancelled) {
        turn.resolve({ stopReason: 'cancelled' });
        return;
      }
      if (failed) {
        turn.reject(
          new Error(
            final.error?.message ||
              'Antigravity yanıtı tamamlanamadı. Oturum açma ve bağlantı durumunu kontrol edin.'
          )
        );
        return;
      }
      if (!turn.emitted && turn.deniedTools?.length > 0) {
        const names = [...new Set(turn.deniedTools)].join(', ');
        this.update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Bazı araç çağrıları izin kipi nedeniyle engellendi (${names}). Alt çubuktan **Otomatik onay** kipine geçerek veya aracı onaylayarak yeniden deneyebilirsiniz.`,
          },
        });
      }
      turn.resolve({
        stopReason:
          typeof stopReason === 'string' && stopReason !== 'cancelled' ? stopReason : 'end_turn',
      });
    })();
  }
  handleAcpNotification(sessionId, proc, s, method, params) {
    if (method !== 'session/update' || proc.attaching || proc.detached) return;
    if (params?.sessionId && proc.childSessionId && params.sessionId !== proc.childSessionId)
      return;
    const u = params?.update;
    if (!u || typeof u !== 'object') return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.type === 'text' ? u.content.text : '';
        if (typeof text === 'string' && text)
          this.emitAgentText(sessionId, proc, `acp-${proc.acpTextKey}`, text);
        return;
      }
      case 'agent_thought_chunk':
        if (u.content?.type === 'text' && u.content.text)
          this.update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: u.content });
        return;
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof u.toolCallId !== 'string' || !u.toolCallId) return;
        // A sub-agent's own tool call (shown only when it needs approval): its card's activity
        // timeline shows it from the sub-agent's transcript, so it is no row of this conversation.
        if (subagentOfToolCallId(u.toolCallId)) return;
        let known = proc.acpTools.get(u.toolCallId);
        // A closed background row keeps its final state; agy may repeat the end.
        if (known?.closed) return;
        if (!known) {
          known = { key: `acp-${++proc.acpToolSeq}` };
          proc.acpTools.set(u.toolCallId, known);
          // Text after a tool is a new reply segment.
          proc.acpTextKey += 1;
        }
        const converted = acpToolStep(u, known);
        known.name = converted.name;
        known.args = converted.args;
        known.status = converted.status;
        const rowId = 'agy-' + known.key;
        if (converted.name === 'invoke_subagent') {
          this.handleAcpInvokeSubagent(sessionId, proc, s, u.toolCallId, rowId, converted);
          return;
        }
        const title = subagentToolTitle(converted.name, converted.args);
        if (title) converted.step.display_title = title;
        const background = proc.backgroundTasks.has(rowId);
        // After a Stop agy fails the task's row; the turn's end marks it stopped (and says the
        // command was ended) like on stream-json.
        if (background && converted.step.state === 'DONE' && proc.currentTurn?.cancelled) return;
        this.handleStepUpdate(sessionId, proc, s, { ...converted.step, step_index: known.key });
        if (background && !proc.backgroundTasks.has(rowId)) known.closed = true;
        return;
      }
      case 'plan':
        if (Array.isArray(u.entries))
          this.update(sessionId, { sessionUpdate: 'plan', entries: u.entries });
        return;
      case 'usage_update':
        if (Number.isFinite(u.used) && Number.isFinite(u.size))
          this.update(sessionId, {
            sessionUpdate: 'usage_update',
            used: u.used,
            size: u.size,
            ...(u.cost ? { cost: u.cost } : {}),
          });
        return;
      default:
        // agy's own config/mode/command/title updates: this adapter owns those.
        return;
    }
  }
  // --- agy's built-in sub-agents (invoke_subagent) on the acp transport -------------------------
  // The stream-json transport learns them from `step_type: 'subagent'` steps; agy acp only shows
  // the `invoke_subagent` tool call (see agy-acp-transport.mjs). Each call becomes a card at once;
  // its conversation is found in agy's brain directory and its transcript gives the live steps,
  // the model and the final answer. The card is detached: agy runs it inside its own process and
  // nothing in Orkestra can stop that one sub-agent, so the card offers no Stop.
  agySubagentMeta(entry, kind, extra = {}) {
    return {
      kind,
      toolCallId: entry.rowId,
      title: entry.title,
      provider: 'antigravity',
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.prompt ? { prompt: entry.prompt } : {}),
      ...(entry.conversationId ? { agentId: entry.conversationId } : {}),
      ...(entry.outputFile ? { outputFile: entry.outputFile } : {}),
      background: true,
      detached: true,
      ...extra,
    };
  }
  emitAgySubagent(sessionId, entry, status, extra = {}) {
    const first = !entry.emitted;
    entry.emitted = true;
    this.update(sessionId, {
      sessionUpdate: first ? 'tool_call' : 'tool_call_update',
      toolCallId: entry.rowId,
      title: entry.title,
      kind: 'other',
      status: extra.statusUnknown ? 'completed' : status,
      ...(first ? { rawInput: { role: entry.title, type: entry.role, prompt: entry.prompt } } : {}),
      _meta: {
        antigravity: this.agySubagentMeta(entry, first ? 'subagent' : 'subagent_update', {
          status: extra.statusUnknown ? 'completed' : status,
          ...extra,
        }),
      },
    });
  }
  handleAcpInvokeSubagent(sessionId, proc, s, acpId, rowId, converted) {
    let entry = proc.agySubagents.get(acpId);
    if (!entry) {
      const args =
        converted.args && typeof converted.args === 'object' && !Array.isArray(converted.args)
          ? converted.args
          : {};
      const text = (value) => (typeof value === 'string' ? unwrapQuotedString(value).trim() : '');
      entry = {
        acpId,
        rowId,
        title: text(args.Role) || 'Alt Ajan',
        role: text(args.TypeName) || undefined,
        prompt: text(args.Prompt) || undefined,
        conversationId: null,
        outputFile: undefined,
        lastStatus: 'in_progress',
        emitted: false,
        resolving: false,
        startedAt: Date.now(),
      };
      proc.agySubagents.set(acpId, entry);
      this.emitAgySubagent(sessionId, entry, 'in_progress');
    }
    if (converted.status === 'failed' && entry.lastStatus === 'in_progress') {
      // agy could not start it: the call's own error is the card's answer.
      entry.lastStatus = 'failed';
      const error = converted.step.tool_info?.error;
      this.emitAgySubagent(sessionId, entry, 'failed', {
        summary: typeof error === 'string' ? error : 'Alt ajan başlatılamadı.',
      });
      return;
    }
    // `completed` only means "started"; the card follows the sub-agent's own conversation.
    if (converted.status === 'completed' && !entry.resolving) {
      entry.resolving = true;
      void this.resolveAgySubagent(sessionId, proc, s, entry);
    }
  }
  async findAgySubagentConversation(proc, parentId, entry) {
    if (typeof parentId !== 'string' || !UUID.test(parentId)) return undefined;
    let names;
    try {
      names = await readdir(join(this.brainDirectory, parentId, '.system_generated', 'subagents'));
    } catch {
      return undefined;
    }
    const claimed = new Set(
      [...proc.agySubagents.values()].map((other) => other.conversationId).filter(Boolean)
    );
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5).toLowerCase() : '';
      if (!UUID.test(id) || claimed.has(id)) continue;
      let files;
      try {
        files = await readdir(join(this.brainDirectory, id, '.system_generated', 'messages'));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'read.json') continue;
        try {
          const message = JSON.parse(
            await readFile(
              join(this.brainDirectory, id, '.system_generated', 'messages', file),
              'utf8'
            )
          );
          if (isSpawnMessageOf(message, { acpToolCallId: entry.acpId, prompt: entry.prompt }))
            return id;
        } catch {
          /* a message still being written */
        }
      }
    }
    return undefined;
  }
  async resolveAgySubagent(sessionId, proc, s, entry) {
    const deadline = Date.now() + this.subagentResolveMs;
    for (;;) {
      if (proc.closed || entry.lastStatus !== 'in_progress') return;
      const id = await this.findAgySubagentConversation(proc, s.nativeId, entry);
      if (id && !entry.conversationId) {
        entry.conversationId = id;
        entry.outputFile = join(
          this.brainDirectory,
          id,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
        this.emitAgySubagent(sessionId, entry, 'in_progress');
        this.startAgySubagentWatcher(sessionId, proc, s, entry);
        return;
      }
      if (Date.now() >= deadline) return; // stays running; the process end settles it
      await new Promise((resolve) => setTimeout(resolve, this.subagentPollMs).unref?.());
    }
  }
  // Did agy leave "Subagent <id> has been explicitly canceled" in the parent's messages?
  async agySubagentCancelled(parentId, conversationId, seen, since) {
    const dir = join(this.brainDirectory, parentId, '.system_generated', 'messages');
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return false;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'read.json' || seen.has(file)) continue;
      try {
        const message = JSON.parse(await readFile(join(dir, file), 'utf8'));
        seen.add(file);
        if (isSubagentCancelledMessage(message, conversationId, since)) return true;
      } catch {
        /* a message still being written: read it again next time */
      }
    }
    return false;
  }
  // Reads the sub-agent's transcript (and its cancellation) into one comparable card state.
  async readAgySubagentState(parentId, entry, seen) {
    let raw;
    try {
      raw = await readFile(entry.outputFile, 'utf8');
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? undefined : parseSubagentTranscript(raw);
    // When it started: its transcript's first row, else when this adapter saw it start.
    const firstAt = raw ? Date.parse(/"created_at":"([^"]+)"/.exec(raw)?.[1] ?? '') : NaN;
    const since = Number.isFinite(firstAt) ? firstAt : (entry.startedAt ?? 0);
    if (!entry.cancelled)
      entry.cancelled = await this.agySubagentCancelled(
        parentId,
        entry.conversationId,
        seen,
        since
      );
    const base = {
      ...(parsed?.model ? { model: parsed.model } : {}),
      ...(parsed?.effort ? { effort: parsed.effort } : {}),
      ...(parsed?.activities ? { activities: parsed.activities } : {}),
    };
    if (entry.cancelled && parsed?.status !== 'completed') {
      const denied = entry.denied;
      return {
        status: 'failed',
        ...base,
        interrupted: true,
        summary: denied
          ? `İzin kipi alt ajanın ${denied} çağrısını engelledi; Antigravity alt ajanı durdurdu.`
          : 'Alt ajan durduruldu.',
      };
    }
    return {
      status: parsed?.status ?? 'in_progress',
      ...base,
      ...(parsed?.summary ? { summary: parsed.summary } : {}),
    };
  }
  startAgySubagentWatcher(sessionId, proc, s, entry) {
    const key = 'agy-sub-' + entry.conversationId;
    if (proc.subagentWatchers.has(key)) return;
    const parentId = s.nativeId;
    const seen = new Set();
    const watcher = { timer: null, reading: false, last: '', quiet: 0 };
    const poll = async () => {
      if (proc.closed || watcher.reading) return;
      watcher.reading = true;
      try {
        entry.denied = entry.denied ?? proc.agySubagentDenied?.get(entry.conversationId);
        const state = await this.readAgySubagentState(parentId, entry, seen);
        if (proc.closed) return;
        const serialized = JSON.stringify(state);
        if (serialized !== watcher.last) {
          watcher.last = serialized;
          watcher.quiet = 0;
          entry.lastStatus = state.status;
          const { status, ...extra } = state;
          this.emitAgySubagent(sessionId, entry, status, extra);
        } else if (state.status !== 'in_progress' && ++watcher.quiet >= 100) {
          clearInterval(watcher.timer);
          watcher.timer = null;
        }
      } finally {
        watcher.reading = false;
      }
    };
    watcher.timer = setInterval(() => void poll(), this.subagentPollMs);
    watcher.timer.unref?.();
    proc.subagentWatchers.set(key, watcher);
    void poll();
  }
  // agy acp ended: a sub-agent it was still running ended with it, and how is unknown.
  settleAgySubagents(sessionId, proc) {
    for (const entry of proc.agySubagents?.values() ?? []) {
      if (entry.lastStatus !== 'in_progress') continue;
      entry.lastStatus = 'completed';
      this.emitAgySubagent(sessionId, entry, 'completed', { statusUnknown: true });
    }
  }
  async handleAcpRequest(sessionId, proc, s, method, params) {
    if (method !== 'session/request_permission') return undefined;
    const allow = s.mode === 'auto' || isBuiltinMcpPermission(params, s.mcpServers);
    if (!allow && proc.currentTurn) proc.currentTurn.deniedTools.push(permissionToolName(params));
    // A refused sub-agent tool makes agy cancel that sub-agent; its card says why.
    const subagent = subagentOfToolCallId(params?.toolCall?.toolCallId);
    if (!allow && subagent) proc.agySubagentDenied?.set(subagent, permissionToolName(params));
    return permissionResponse(params, { allow });
  }
  acpProcessGone(sessionId, proc, error, code) {
    if (proc.closed) return;
    proc.closed = true;
    clearTimeout(proc.timer);
    this.settleAgySubagents(sessionId, proc);
    this.stopAllSubagentWatchers(proc);
    if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
    // Pending prompts reject; the turn then ends (cancelled after a Stop, otherwise as lost).
    proc.conn?.fail(
      error ||
        new Error(
          code === 0 || proc.closing
            ? 'Antigravity bağlantısı yanıt tamamlanmadan kapandı.'
            : 'Antigravity yanıtı tamamlanamadı. Oturum açma ve bağlantı durumunu kontrol edin.'
        )
    );
    if (!proc.currentTurn) this.endBackgroundTracking(sessionId, proc, null);
    proc.finish();
  }
  async steerAcp(p, turn, proc) {
    if (!turn.chain) return { outcome: 'queueRequired', queueReason: QUEUE_REASON.connecting };
    if (turn.finished) return { outcome: 'queueRequired' };
    const text = await this.materializePromptBlocks(p.prompt, p.sessionId);
    if (
      this.active.get(p.sessionId) !== turn ||
      this.processes.get(p.sessionId) !== proc ||
      turn.finished ||
      turn.cancelled ||
      proc.closed ||
      proc.closing ||
      !proc.ready
    )
      return turn.finished || this.active.get(p.sessionId) !== turn
        ? { outcome: 'promptRequired' }
        : { outcome: 'queueRequired' };
    const previous = turn.chain.filter((entry) => !entry.settled);
    const entry = this.sendAcpPrompt(p.sessionId, proc, turn, text, true);
    const outcome = await new Promise((resolve) => {
      let decided = false;
      const decide = (value) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        // Taken by agy: from now on an error of this prompt is the turn's own error.
        if (value !== 'rejected') entry.accepted = true;
        resolve(value);
      };
      // No answer in time: the message is with agy all the same (never queued twice).
      const timer = setTimeout(() => decide('injected'), this.steerAcceptTimeoutMs);
      timer.unref?.();
      // agy answers the earlier prompt as soon as the new one joins the running turn.
      for (const earlier of previous) earlier.settledPromise.then(() => decide('injected'));
      entry.settledPromise.then(() => decide(entry.rejected ? 'rejected' : 'injected'));
    });
    return { outcome: outcome === 'rejected' ? 'queueRequired' : 'injected' };
  }
  // Stop on the ACP transport: agy cancels the turn and stops its background tasks and
  // sub-agents itself; owned task processes still alive afterwards are ended here too.
  async cancelAcpTurn(sessionId, proc, turn) {
    const owned = await this.findTaskProcesses(proc);
    for (const task of proc.backgroundTasks.values()) task.terminated = true;
    if (proc.ready && proc.childSessionId && !proc.closed) {
      proc.conn.notify('session/cancel', { sessionId: proc.childSessionId });
      turn.cancelTimer = setTimeout(() => {
        if (turn.finished || proc.closed) return;
        proc.closing = true;
        try {
          proc.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, this.acpCancelGraceMs);
      turn.cancelTimer.unref?.();
    } else {
      proc.closing = true;
      try {
        proc.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    if (owned) {
      void (async () => {
        await new Promise((resolve) => {
          const check = () =>
            turn.finished || proc.closed ? resolve() : setTimeout(check, 100).unref?.();
          check();
        });
        await this.terminateRemainingTaskProcesses(owned.trees);
      })();
    }
  }
  // Signals only processes that still are the same ones (pid, command line and group).
  async terminateRemainingTaskProcesses(trees) {
    let table;
    try {
      table = await this.listProcesses();
    } catch {
      return;
    }
    const alive = trees
      .map((tree) => ({
        ...tree,
        members: tree.members.filter((member) =>
          table.some(
            (row) => row.pid === member.pid && row.args === member.args && row.pgid === member.pgid
          )
        ),
      }))
      .filter((tree) => tree.members.length > 0);
    if (alive.length) this.terminateTaskProcesses(alive);
  }
  // Closing a conversation is not a Stop: agy acp would stop the turn's background work on
  // `session/cancel` or `session/close`, so the turn is let finish on its own, unseen, and the
  // process exits once its prompts have returned.
  detachAcpTurn(sessionId, proc, turn) {
    proc.detached = true;
    for (const task of proc.backgroundTasks.values()) task.detached = true;
    if (this.processes.get(sessionId) === proc) this.processes.delete(sessionId);
    turn.finished = true;
    this.endBackgroundTracking(sessionId, proc, 'detached');
    proc.currentTurn = null;
    if (this.active.get(sessionId) === turn) this.active.delete(sessionId);
    turn.resolve({ stopReason: 'cancelled' });
    const pending = (turn.chain ?? []).filter((entry) => !entry.settled);
    void Promise.all(pending.map((entry) => entry.settledPromise)).then(() => {
      proc.closing = true;
      try {
        proc.child.stdin.end();
      } catch {
        /* ignore */
      }
    });
  }
  async steerSession(p) {
    const turn = this.active.get(p.sessionId);
    const proc = this.processes.get(p.sessionId);
    // A turn whose agy process is still starting or attaching cannot take it yet.
    if (turn && !turn.cancelled && (!turn.child || (proc?.transport === 'acp' && !turn.chain)))
      return { outcome: 'promptRequired', queueReason: QUEUE_REASON.connecting };
    if (!turn || turn.cancelled || !turn.child || !proc || proc.closed || proc.closing) {
      return { outcome: 'promptRequired' };
    }
    // agy acp takes the message into the running turn (see agy-acp-transport.mjs).
    if (proc.transport === 'acp') return this.steerAcp(p, turn, proc);
    // stream-json: agy reads no stdin line until this turn's `result` (see the note at the top), including while
    // it waits on a background task. Writing the line now would only park it, and stopping the turn
    // to deliver it would abandon the work in flight (an orphaned background task is usually started
    // again: duplicate generations and credits). Ask the runtime to hold the message and send it as
    // the next prompt when the turn ends; the user can still stop the turn explicitly ("send now").
    // `queueReason` tells the user why (an Orchestrator session stays on stream-json on purpose).
    const s = this.sessions.get(p.sessionId);
    return {
      outcome: 'queueRequired',
      queueReason: isOrchestratorModel(s?.model)
        ? QUEUE_REASON.antigravityOrchestrator
        : QUEUE_REASON.antigravityStreamJson,
    };
  }
  // ACP `session/cancel`: the user stopped the turn. Its background tasks stop with it.
  async cancel(p) {
    return this.cancelTurn(p, { stopBackgroundTasks: true });
  }
  async cancelTurn(p, { stopBackgroundTasks }) {
    const state = this.active.get(p.sessionId);
    const proc = this.processes.get(p.sessionId);
    if (state && !state.cancelled && proc?.transport === 'acp' && state.chain) {
      if (!stopBackgroundTasks) {
        state.cancelled = true;
        this.detachAcpTurn(p.sessionId, proc, state);
        return {};
      }
      state.cancelled = true;
      await this.cancelAcpTurn(p.sessionId, proc, state);
      return {};
    }
    if (state && !state.cancelled) {
      state.cancelled = true;
      if (proc && state.child) {
        proc.closing = true;
        // Find the task processes while agy still parents them; after SIGINT they are orphans.
        const owned = stopBackgroundTasks ? await this.findTaskProcesses(proc) : undefined;
        proc.child.kill('SIGINT');
        if (owned) this.terminateTaskProcesses(owned.trees);
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
      // Closing a conversation is not a Stop; its background tasks are left alone (and say so).
      const detaching = this.processes.get(p.sessionId)?.transport === 'acp';
      await this.cancelTurn(p, { stopBackgroundTasks: false });
      // A detached agy acp process finishes its work on its own (see detachAcpTurn).
      if (!detaching) await state.done;
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
  const bridge = new AntigravityBridge({
    notify: write,
    transport: process.env[AGY_TRANSPORT_ENV] || 'auto',
  });
  const methods = {
    initialize: 'initialize',
    'session/new': 'newSession',
    'session/load': 'loadSession',
    'session/prompt': 'prompt',
    'session/set_config_option': 'setSessionConfigOption',
    'session/cancel': 'cancel',
    'session/close': 'closeSession',
    '_session/steering': 'steerSession',
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
