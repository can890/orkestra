import { spawn, execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const FALLBACK_MODELS = [
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
    .map(([value, name]) => ({ value, name: name.replace('(High)', '(Yüksek)').replace('(Medium)', '(Orta)').replace('(Low)', '(Düşük)').replace('(Thinking)', '(Düşünen)') }));
}
export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.some((b) => b.type !== 'text'))
    throw new Error('Antigravity sohbeti şu anda yalnızca metin iletilerini destekler.');
  return blocks.map((b) => b.text).join('\n');
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
    notify = () => {},
    spawnProcess = spawn,
    exec = execFile,
  } = {}) {
    this.cli = cli;
    this.directory = directory;
    this.notify = notify;
    this.spawnProcess = spawnProcess;
    this.exec = exec;
    this.sessions = new Map();
    this.active = new Map();
    this.models = FALLBACK_MODELS.map(([value, name]) => ({ value, name: name.replace('(High)', '(Yüksek)').replace('(Medium)', '(Orta)').replace('(Low)', '(Düşük)').replace('(Thinking)', '(Düşünen)') }));
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
    return { configOptions: this.options(s) };
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
      const done = new Promise((resolve) => { finish = resolve; });
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
              const data = {
                sessionUpdate: known ? 'tool_call_update' : 'tool_call',
                toolCallId: id,
                title: u.tool_name || 'Araç',
                kind: 'other',
                status:
                  u.state === 'DONE'
                    ? u.tool_info?.error
                      ? 'failed'
                      : 'completed'
                    : 'in_progress',
                rawInput: u.tool_info?.parameters,
                rawOutput: u.tool_info?.output,
              };
              this.update(p.sessionId, data);
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
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) serve();
