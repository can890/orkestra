import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const FALLBACK_MODELS = [
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
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (Yüksek)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Orta)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Düşük)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (Yüksek)'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Orta)'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Düşük)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (Yüksek)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Orta)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Düşük)'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (Yüksek)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Düşük)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Düşük)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Orta)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (Yüksek)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Düşük)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Orta)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (Yüksek)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Düşünen)'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Düşünen)'],
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
    .map((line) => line.trim().split(/\t+/))
    .filter((parts) => parts.length >= 2 && /^[a-z0-9][a-z0-9._-]+$/.test(parts[0]))
    .map(([value, name]) => ({
      value,
      name: name
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
        /* already a plain string */
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
  return args;
}
export class AntigravityBridge {
  constructor({
    cli = process.env.ORKESTRA_AGY_EXECUTABLE,
    directory = join(homedir(), '.local', 'state', 'orkestra', 'antigravity'),
    brainDirectory = join(homedir(), '.gemini', 'antigravity-cli', 'brain'),
    notify = () => {},
    spawnProcess = spawn,
    exec = execFile,
  } = {}) {
    this.cli = cli;
    this.directory = directory;
    this.brainDirectory = brainDirectory;
    this.notify = notify;
    this.spawnProcess = spawnProcess;
    this.exec = exec;
    this.sessions = new Map();
    this.active = new Map();
    this.swarms = new Map(); // sessionId -> { members: name -> row state, chain }
    this.models = FALLBACK_MODELS.map(([value, name]) => ({
      value,
      name: name
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
  options(s) {
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: s.model,
        options: this.models,
      },
      {
        id: 'mode',
        name: 'İzin kipi',
        category: 'mode',
        type: 'select',
        currentValue: s.mode,
        options: modes,
      },
    ];
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
  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: 'Orkestra Antigravity', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {} },
        promptCapabilities: { image: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  }
  async newSession(p) {
    if (!isAbsolute(p.cwd) || !(await stat(p.cwd)).isDirectory())
      throw new Error('Geçerli bir çalışma klasörü gerekli.');
    await this.catalog();
    const id = randomUUID(),
      s = { cwd: p.cwd, model: this.models[0].value, mode: 'default' };
    this.sessions.set(id, s);
    await this.save(id, s);
    return { sessionId: id, configOptions: this.options(s) };
  }
  async loadSession(p) {
    if (!/^[a-f0-9-]{36}$/.test(p.sessionId)) throw new Error('Geçersiz oturum kimliği.');
    const s = JSON.parse(await readFile(join(this.directory, p.sessionId + '.json'), 'utf8'));
    if (s.cwd !== p.cwd) throw new Error('Oturum başka bir çalışma klasörüne ait.');
    // Permissions are always reselected by the host; never inherit an old bypass.
    s.mode = 'default';
    await this.catalog();
    this.sessions.set(p.sessionId, s);
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
      const send = (sessionUpdate, content) =>
        this.update(sessionId, { sessionUpdate, content: { type: 'text', text: content } });
      let pending = [], // tool calls waiting for their GENERIC result, in order
        started = false;
      const members = new Map(); // toolCallId -> swarm member name (swarm add calls)
      const flush = () => {
        for (const call of pending)
          this.update(sessionId, {
            ...call,
            status: members.has(call.toolCallId) ? 'in_progress' : 'completed',
          });
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
              this.swarmMembers(sessionId).set(member, {
                toolCallId: call.toolCallId,
                afterSeq: swarmBriefSeq(row.content),
                replayed: true,
                sent: 'in_progress|',
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
        if (row.type === 'USER_INPUT') {
          const text = replayUserText(row.content);
          if (!text) continue;
          begin();
          send('user_message_chunk', text);
        } else if (row.type === 'PLANNER_RESPONSE') {
          if (typeof row.content === 'string' && row.content.trim()) {
            begin();
            send('agent_message_chunk', row.content);
          }
          if (Array.isArray(row.tool_calls)) {
            row.tool_calls.forEach((tool, i) => {
              if (!tool || typeof tool !== 'object') return;
              begin();
              const toolCallId = `agy-replay-${row.step_index}-${i}`,
                swarm = swarmCall(tool.name, tool.args, this.modelName);
              if (swarm?.member) members.set(toolCallId, swarm.member);
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
    if (p.configId === 'model') {
      if (!this.models.some((m) => m.value === p.value))
        throw new Error('Desteklenmeyen Antigravity modeli.');
      s.model = p.value;
    } else if (p.configId === 'mode') {
      if (!modes.some((m) => m.value === p.value)) throw new Error('Geçersiz izin kipi.');
      s.mode = p.value;
    } else throw new Error('Bilinmeyen oturum ayarı.');
    await this.save(p.sessionId, s);
    return { configOptions: this.options(s) };
  }
  update(id, update) {
    this.notify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update } });
  }
  async prompt(p) {
    const s = this.session(p.sessionId),
      text = promptText(p.prompt);
    if (this.active.has(p.sessionId)) throw new Error('Bu oturumda zaten bir yanıt hazırlanıyor.');
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.cli, buildArgs(s), {
        cwd: s.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const state = { child, cancelled: false, timer: null, done };
      this.active.set(p.sessionId, state);
      let final = null,
        emitted = false,
        parseError = null;
      const tools = new Set();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          if (line.length > 2 * 1024 * 1024) throw new Error('Antigravity yanıt satırı çok büyük.');
          const event = JSON.parse(line);
          if (event.event === 'init' && event.conversation_id) s.nativeId = event.conversation_id;
          if (event.event === 'step_update') {
            const u = event.step_update;
            if (u.step_type === 'agent_response' && u.text_delta) {
              emitted = true;
              this.update(p.sessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: u.text_delta },
              });
            }
            if (u.step_type === 'tool') {
              const id = 'agy-' + u.step_index,
                known = tools.has(id);
              tools.add(id);
              const swarm = swarmCall(u.tool_name, u.tool_info?.parameters, this.modelName);
              const done = u.state === 'DONE';
              let status = done ? (u.tool_info?.error ? 'failed' : 'completed') : 'in_progress';
              if (swarm?.member) {
                // The add call only launches the member; its row stays live until it reports.
                if (done && !swarmAddFailed(u.tool_info?.output, u.tool_info?.error))
                  status = 'in_progress';
                else if (done) status = 'failed';
                if (done && status !== 'failed')
                  this.swarmMembers(p.sessionId).set(swarm.member, {
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
              };
              this.update(p.sessionId, data);
              if (done && SWARM_SYNC_TOOLS.has(u.tool_name))
                this.syncSwarm(p.sessionId, s.nativeId);
            }
          }
          if (event.event === 'result') {
            final = event.result;
            if (final.conversation_id) s.nativeId = final.conversation_id;
          }
        } catch (error) {
          parseError = error;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', (error) => {
        this.active.delete(p.sessionId);
        clearTimeout(state.timer);
        finish();
        reject(error);
      });
      child.on('close', async (code) => {
        clearTimeout(state.timer);
        try {
          await this.save(p.sessionId, s);
          await this.syncSwarm(p.sessionId, s.nativeId);
          if (state.cancelled || ['CANCELED', 'INTERRUPTED'].includes(final?.status)) {
            resolve({ stopReason: 'cancelled' });
            return;
          }
          if (parseError) throw parseError;
          if (code !== 0 || final?.status !== 'SUCCESS')
            throw new Error(
              final?.error ||
                'Antigravity yanıtı tamamlanamadı. Oturum açma ve bağlantı durumunu kontrol edin.'
            );
          if (!emitted && final.response)
            this.update(p.sessionId, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: final.response },
            });
          resolve({ stopReason: 'end_turn' });
        } catch (error) {
          reject(error);
        } finally {
          this.active.delete(p.sessionId);
          finish();
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
    });
  }
  async cancel(p) {
    const state = this.active.get(p.sessionId);
    if (state && !state.cancelled) {
      state.cancelled = true;
      state.child.kill('SIGINT');
      state.timer = setTimeout(() => state.child.kill('SIGKILL'), 5000);
      state.timer.unref();
    }
    return {};
  }
  async closeSession(p) {
    const state = this.active.get(p.sessionId);
    if (state) {
      await this.cancel(p);
      // Wait until the child exits and its native conversation ID has been saved.
      await state.done;
    }
    this.sessions.delete(p.sessionId);
    return {};
  }
  async shutdown() {
    for (const id of this.active.keys()) await this.cancel({ sessionId: id });
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
