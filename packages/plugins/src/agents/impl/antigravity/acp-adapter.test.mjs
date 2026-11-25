import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  AntigravityBridge,
  buildArgs,
  extractExternalSubagentCall,
  FALLBACK_MODELS,
  parseModels,
  promptText,
  REPLAY_MAX_LINES,
  SWARM_REPLY_LIMIT,
} from './acp-adapter.mjs';
test('model slugs are parsed, status chatter is ignored', () =>
  assert.deepEqual(parseModels('Fetching models...\nmodel-1\tModel One\n'), [
    { value: 'model-1', name: 'Model One' },
  ]));
test('fallback catalog includes the Gemini 4 Argon tiers', () => {
  const ids = FALLBACK_MODELS.map(([id]) => id);
  for (const tier of ['low', 'medium', 'high']) assert.ok(ids.includes(`gemini-4-argon-${tier}`));
});
test('fallback catalog includes all Gemini 4 Neon variants', () => {
  const ids = FALLBACK_MODELS.map(([id]) => id);
  for (const tier of ['low', 'medium', 'high', 'xhigh']) {
    assert.ok(ids.includes(`gemini-4-neon-${tier}`));
  }
  assert.ok(ids.includes('gemini-pro-orchestrator-neon'));
  assert.deepEqual(parseModels('gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n'), [
    { value: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (Çok Yüksek)' },
  ]);
});
test('permissions are not bypassed unless explicitly selected', () => {
  assert.ok(!buildArgs({ model: 'm', mode: 'default' }).includes('--dangerously-skip-permissions'));
  assert.ok(buildArgs({ model: 'm', mode: 'auto' }).includes('--dangerously-skip-permissions'));
  assert.deepEqual(buildArgs({ model: 'm', mode: 'plan', nativeId: 'native' }).slice(-4), [
    '--conversation',
    'native',
    '--mode',
    'plan',
  ]);
});
test('non-text content fails clearly instead of being silently discarded', () => {
  assert.equal(
    promptText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb'
  );
  assert.throws(() => promptText([{ type: 'image', data: 'x' }]), /yalnızca metin/);
});
async function setup(t, events, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-test-'));
  const updates = [],
    calls = [];
  let child;
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    ...extra,
    notify: (x) => updates.push(x),
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
    spawnProcess: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (signal) => {
          calls.push({ signal });
          setImmediate(() => child.emit('close', 1));
          return true;
        },
      });
      child.stdin.on('data', () =>
        setImmediate(() => {
          if (events) {
            for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
          }
        })
      );
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const { sessionId } = await b.newSession({ cwd: directory });
  return { b, sessionId, updates, calls, directory };
}
test('streamed response is not duplicated by the final result', async (t) => {
  const { b, sessionId, updates, calls } = await setup(t, [
    { event: 'init', conversation_id: 'native' },
    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'OK' } },
    { event: 'result', result: { status: 'SUCCESS', response: 'OK', conversation_id: 'native' } },
  ]);
  assert.deepEqual(await b.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] }), {
    stopReason: 'end_turn',
  });
  assert.equal(updates.length, 1);
  assert.equal(b.session(sessionId).nativeId, 'native');
  assert.ok(!calls[0].args.includes('hello'));
});
test('final-only response is delivered and failed tools remain failed', async (t) => {
  const { b, sessionId, updates } = await setup(t, [
    {
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        step_index: 2,
        state: 'DONE',
        tool_name: 'run_command',
        tool_info: { error: { message: 'denied' } },
      },
    },
    { event: 'result', result: { status: 'SUCCESS', response: 'OK' } },
  ]);
  await b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
  assert.equal(updates[0].params.update.status, 'failed');
  assert.equal(updates[1].params.update.content.text, 'OK');
});
test('failed runs reject instead of appearing complete', async (t) => {
  const { b, sessionId } = await setup(t, [
    { event: 'result', result: { status: 'ERROR', error: 'model unavailable' } },
  ]);
  await assert.rejects(
    b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] }),
    /model unavailable/
  );
});
test('cancellation signals the owned process and resolves cancelled', async (t) => {
  const { b, sessionId, calls } = await setup(t, null);
  const promise = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await b.cancel({ sessionId });
  assert.deepEqual(await promise, { stopReason: 'cancelled' });
  assert.equal(calls[1].signal, 'SIGINT');
});
test('resume preserves the native session but resets permission bypass', async (t) => {
  const { b, sessionId, directory } = await setup(t, []);
  b.session(sessionId).nativeId = 'native';
  await b.setSessionConfigOption({ sessionId, configId: 'mode', value: 'auto' });
  await b.loadSession({ sessionId, cwd: directory });
  assert.equal(b.session(sessionId).mode, 'default');
  assert.equal(b.session(sessionId).nativeId, 'native');
  await assert.rejects(b.loadSession({ sessionId: '../escape', cwd: directory }), /Geçersiz/);
  await assert.rejects(b.loadSession({ sessionId, cwd: '/wrong' }), /başka/);
});
test('unknown models and overlapping turns are rejected', async (t) => {
  const { b, sessionId } = await setup(t, null);
  await assert.rejects(
    b.setSessionConfigOption({ sessionId, configId: 'model', value: 'fake' }),
    /Desteklenmeyen/
  );
  const first = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await assert.rejects(b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] }), /zaten/);
  await b.cancel({ sessionId });
  await first;
});

test(
  'ACP starts when the entry point is reached through a symlink',
  { timeout: 5000 },
  async (t) => {
    const { symlink } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { spawn } = await import('node:child_process');
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-link-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entry = join(directory, 'adapter.mjs');
    await symlink(fileURLToPath(new URL('./acp-adapter.mjs', import.meta.url)), entry);
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const response = new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Adapter exited before response: ${code}`)));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      }) + '\n'
    );
    assert.equal((await response).result.protocolVersion, 1);
  }
);

test('closing waits for cancellation and preserves the resumable native conversation', async (t) => {
  const { b, sessionId, calls, directory } = await setup(t, null);
  b.session(sessionId).nativeId = 'native-close';
  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await b.closeSession({ sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(b.active.size, 0);
  assert.equal(b.sessions.has(sessionId), false);
  assert.equal(calls.filter((c) => c.signal === 'SIGINT').length, 1);
  await b.closeSession({ sessionId });
  await b.loadSession({ sessionId, cwd: directory });
  assert.equal(b.session(sessionId).nativeId, 'native-close');
});

test('idle close is idempotent and declares the close capability', async (t) => {
  const { b, sessionId, directory } = await setup(t, []);
  assert.deepEqual((await b.initialize()).agentCapabilities.sessionCapabilities.close, {});
  await b.closeSession({ sessionId });
  await b.closeSession({ sessionId });
  await b.loadSession({ sessionId, cwd: directory });
  assert.equal(b.session(sessionId).cwd, directory);
});

test(
  'the ACP wire accepts session/close instead of rejecting teardown',
  { timeout: 5000 },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./acp-adapter.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    t.after(() => child.kill());
    const response = new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Adapter exited before close response: ${code}`))
      );
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/close',
        params: { sessionId: 'already-closed' },
      }) + '\n'
    );
    assert.deepEqual(await response, { jsonrpc: '2.0', id: 1, result: {} });
  }
);

const NATIVE = '38ea5df0-86ad-49c8-b842-f2f6b6c8cbca';
async function replaySetup(t, { nativeId = NATIVE, transcript } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-replay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'state'),
    brainDirectory = join(root, 'brain'),
    cwd = join(root, 'cwd'),
    sessionId = '11111111-2222-3333-4444-555555555555',
    updates = [];
  await mkdir(directory, { recursive: true });
  await mkdir(cwd);
  const state = { cwd, model: 'model-1', mode: 'default' };
  if (nativeId !== undefined) state.nativeId = nativeId;
  await writeFile(join(directory, sessionId + '.json'), JSON.stringify(state));
  if (transcript !== undefined && typeof nativeId === 'string') {
    const logs = join(brainDirectory, nativeId, '.system_generated', 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'transcript.jsonl'), transcript);
  }
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    brainDirectory,
    notify: (x) => updates.push(x.params.update),
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
  });
  return { b, sessionId, cwd, updates, root, brainDirectory };
}
const jsonl = (rows) =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const userRow = (step, text) => ({
  step_index: String(step),
  type: 'USER_INPUT',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>`,
});

test('history is replayed in order before loadSession resolves', async (t) => {
  const transcript = jsonl([
    userRow(0, 'merhaba\n<orkestra_context>\ngizli bağlam\n</orkestra_context>\n'),
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: 'bakıyorum',
      thinking: 'düşünce',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls' } },
        { name: 'read_file', args: { Path: '/x' } },
      ],
    },
    {
      step_index: '2',
      type: 'GENERIC',
      content: 'Created At: t\nCompleted At: t\nCommand exited with code 2.\nhata',
    },
    { step_index: '3', type: 'GENERIC', content: 'dosya içeriği' },
    { step_index: '4', type: 'SYSTEM_MESSAGE', content: 'sistem' },
    {
      step_index: '5',
      type: 'USER_INPUT',
      content: '<USER_SETTINGS_CHANGE>\nmodel\n</USER_SETTINGS_CHANGE>',
    },
    { step_index: '6', type: 'PLANNER_RESPONSE', content: 'bitti', tool_calls: [] },
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  let resolved = false;
  const pending = b.loadSession({ sessionId, cwd }).then((r) => {
    resolved = true;
    return r;
  });
  const result = await pending;
  assert.ok(result.configOptions);
  assert.ok(updates.length > 0 && resolved);
  assert.deepEqual(
    updates.map((u) => u.sessionUpdate),
    ['user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call', 'agent_message_chunk']
  );
  assert.equal(updates[0].content.text, 'merhaba');
  assert.equal(updates[1].content.text, 'bakıyorum');
  assert.deepEqual(
    { ...updates[2] },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'agy-replay-1-0',
      title: 'run_command',
      kind: 'other',
      rawInput: { CommandLine: 'ls' },
      status: 'failed',
      rawOutput: 'Command exited with code 2.\nhata',
    }
  );
  assert.equal(updates[3].toolCallId, 'agy-replay-1-1');
  assert.equal(updates[3].status, 'completed');
  assert.equal(updates[3].rawOutput, 'dosya içeriği');
  assert.equal(updates[4].content.text, 'bitti');
});

test('a tool call without a result is still replayed as completed', async (t) => {
  const transcript = jsonl([
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'a', args: {} }],
    },
    userRow(2, 'sonraki'),
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  assert.deepEqual(
    updates.map((u) => [u.sessionUpdate, u.status]),
    [
      ['tool_call', 'completed'],
      ['user_message_chunk', undefined],
    ]
  );
  assert.ok(!('rawOutput' in updates[0]));
});

test('long tool output is truncated', async (t) => {
  const transcript = jsonl([
    { step_index: '1', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'a', args: {} }] },
    { step_index: '2', type: 'GENERIC', content: 'x'.repeat(50000) },
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  assert.ok(updates[0].rawOutput.length < 4100);
});

test('missing transcript, no native id and non-UUID ids replay nothing and still load', async (t) => {
  for (const nativeId of [NATIVE, undefined, '../../etc', 'native']) {
    const { b, sessionId, cwd, updates } = await replaySetup(t, { nativeId });
    const result = await b.loadSession({ sessionId, cwd });
    assert.ok(result.configOptions);
    assert.deepEqual(updates, []);
  }
});

test('a non-UUID native id never reaches the filesystem', async (t) => {
  const { b, sessionId, cwd, updates, root } = await replaySetup(t, { nativeId: '../outside' });
  await mkdir(join(root, 'outside', '.system_generated', 'logs'), { recursive: true });
  await writeFile(
    join(root, 'outside', '.system_generated', 'logs', 'transcript.jsonl'),
    jsonl([userRow(0, 'sızıntı')])
  );
  await b.loadSession({ sessionId, cwd });
  assert.deepEqual(updates, []);
});

test('malformed lines are skipped and the rest is replayed', async (t) => {
  const transcript = jsonl([
    '{not json',
    userRow(0, 'bir'),
    '"just a string"',
    'null',
    { step_index: '1', type: 'PLANNER_RESPONSE', content: 'iki', tool_calls: 'bozuk' },
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  assert.deepEqual(
    updates.map((u) => u.content.text),
    ['bir', 'iki']
  );
});

test('replay is capped to the latest lines and says so', async (t) => {
  const rows = [];
  for (let i = 0; i < REPLAY_MAX_LINES + 50; i++) rows.push(userRow(i, 'm' + i));
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript: jsonl(rows) });
  await b.loadSession({ sessionId, cwd });
  assert.equal(updates.length, REPLAY_MAX_LINES + 1);
  assert.equal(updates[0].sessionUpdate, 'agent_message_chunk');
  assert.match(updates[0].content.text, /kısaltıldı/);
  assert.equal(updates[1].content.text, 'm50');
  assert.equal(updates.at(-1).content.text, 'm' + (REPLAY_MAX_LINES + 49));
});

// --- Swarm sub-agent rows (synthetic data only) ---
async function writeSwarm(brainDirectory, nativeId, { board, members }) {
  const dir = join(brainDirectory, nativeId, '.system_generated', 'swarm');
  await mkdir(dir, { recursive: true });
  if (board !== undefined) await writeFile(join(dir, 'board.jsonl'), board);
  if (members !== undefined) await writeFile(join(dir, 'members.json'), members);
}
const post = (seq, agent, text) => ({ seq, agent, text, time: 'now' });
const addParams = (name, brief = `${name} görevi`) => ({
  action: 'add',
  name,
  brief,
  model: 'model-1',
  workspace: 'inherit',
});
const addOutput = (name, seq) =>
  `Created At: t\nCompleted At: t\n${JSON.stringify({
    status: 'added',
    name,
    model: 'model-1',
    conversation_id: '1d44b7b3-16ae-4e09-95dd-d686598e2d92',
    note: `The brief is on the board as #${seq}, where every member of the swarm can read it.`,
  })}`;
const toolEvent = (index, state, name, parameters, output) => ({
  event: 'step_update',
  step_update: {
    step_type: 'tool',
    step_index: index,
    state,
    tool_name: name,
    tool_info: { name, parameters, ...(output === undefined ? {} : { output }) },
  },
});
const addEvents = (index, name, seq) => [
  toolEvent(index, 'ACTIVE', 'swarm', addParams(name)),
  toolEvent(index, 'DONE', 'swarm', addParams(name), addOutput(name, seq)),
];
async function liveSwarm(t, events, files) {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-swarm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const brainDirectory = join(root, 'brain');
  if (files) await writeSwarm(brainDirectory, NATIVE, files);
  const run = await setup(
    t,
    [
      { event: 'init', conversation_id: NATIVE },
      ...events,
      { event: 'result', result: { status: 'SUCCESS', response: 'ok', conversation_id: NATIVE } },
    ],
    { brainDirectory }
  );
  await run.b.prompt({ sessionId: run.sessionId, prompt: [{ type: 'text', text: 'x' }] });
  const rows = run.updates.map((u) => u.params.update).filter((u) => u.toolCallId);
  return { ...run, rows, brainDirectory };
}
const reply = (update) => update.content?.[0]?.content?.text;

test('swarm add becomes a sub-agent row carrying the task', async (t) => {
  const { rows } = await liveSwarm(t, addEvents(3, 'scout', 1));
  assert.equal(rows[0].sessionUpdate, 'tool_call');
  assert.equal(rows[0].kind, 'subagent');
  assert.equal(rows[0].title, 'scout · Model One');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[0].rawInput.description, 'scout görevi');
  assert.equal(rows[0].rawInput.prompt, 'scout görevi');
  assert.equal(rows[0].rawInput.name, 'scout');
  // The add call only launches the member: its row stays running until it reports.
  assert.equal(rows.at(-1).toolCallId, 'agy-3');
  assert.equal(rows.at(-1).status, 'in_progress');
});

test('board replies land on the matching member row and [done] completes it', async (t) => {
  const board = jsonl([
    post(1, 'coordinator', '@scout görevi'),
    post(2, 'scout', '@coordinator ilk bulgu'),
    post(3, 'other', '@coordinator [done] başkasının'),
    post(4, 'scout', '@coordinator [done] bitti'),
  ]);
  const { rows } = await liveSwarm(
    t,
    [
      ...addEvents(3, 'scout', 1),
      ...addEvents(4, 'other', 1),
      toolEvent(5, 'DONE', 'swarm_wait', { since: 1 }, 'x'),
    ],
    { board }
  );
  const last = (id) => rows.filter((r) => r.toolCallId === id).at(-1);
  assert.equal(last('agy-3').status, 'completed');
  assert.equal(reply(last('agy-3')), '@coordinator ilk bulgu\n\n@coordinator [done] bitti');
  assert.equal(reply(last('agy-4')), '@coordinator [done] başkasının');
  // Board syncs never resend the kind (a differing kind would reclassify the row).
  const syncs = rows.filter((r) => r.sessionUpdate === 'tool_call_update' && !r.title);
  assert.ok(syncs.length > 0 && syncs.every((r) => !r.kind));
  const withReply = rows.filter((r) => r.toolCallId === 'agy-3' && reply(r));
  assert.equal(withReply.length, 1);
});

test('replies without [done] keep the row running; killed or failed members end it', async (t) => {
  const board = jsonl([
    post(2, 'running', 'ara bulgu'),
    post(3, 'broken', '@coordinator [failed] derlenemedi'),
    post(4, 'killed', 'yarım kaldı'),
  ]);
  const members = JSON.stringify({
    members: {
      running: { phase: 'RUNNING', killed: false },
      broken: { phase: 'RUNNING', killed: false },
      killed: { phase: 'KILLED', killed: true },
      silent: { phase: 'KILLED', killed: true },
    },
  });
  const { rows } = await liveSwarm(
    t,
    [
      ...addEvents(3, 'running', 1),
      ...addEvents(4, 'broken', 1),
      ...addEvents(5, 'killed', 1),
      ...addEvents(6, 'silent', 1),
      toolEvent(7, 'DONE', 'swarm', { action: 'status' }, 'x'),
    ],
    { board, members }
  );
  const last = (id) => rows.filter((r) => r.toolCallId === id).at(-1);
  assert.equal(last('agy-3').status, 'in_progress');
  assert.equal(reply(last('agy-3')), 'ara bulgu');
  assert.equal(last('agy-4').status, 'failed');
  assert.equal(last('agy-5').status, 'completed');
  assert.equal(last('agy-6').status, 'completed');
  assert.equal(last('agy-6').content, undefined);
});

test('posts from before the brief belong to an earlier member of the same name', async (t) => {
  const board = jsonl([post(2, 'scout', '[done] eski'), post(9, 'scout', 'yeni')]);
  const { rows } = await liveSwarm(t, addEvents(3, 'scout', 5), { board });
  const last = rows.filter((r) => r.toolCallId === 'agy-3').at(-1);
  assert.equal(reply(last), 'yeni');
  assert.equal(last.status, 'in_progress');
});

test('missing or malformed swarm files leave the rows running and nothing throws', async (t) => {
  for (const files of [
    undefined,
    { board: 'not json\n{"seq":1\n', members: '{broken' },
    { board: jsonl([{ seq: 1, agent: 5, text: null }, 'null', '[]']), members: '[]' },
  ]) {
    const { rows } = await liveSwarm(t, addEvents(3, 'scout', 1), files);
    assert.deepEqual(
      rows.map((r) => [r.sessionUpdate, r.status]),
      [
        ['tool_call', 'in_progress'],
        ['tool_call_update', 'in_progress'],
      ]
    );
    assert.equal(rows[0].rawInput.description, 'scout görevi');
  }
});

test('a failed swarm add fails the row and registers no member', async (t) => {
  const { rows, b, sessionId } = await liveSwarm(t, [
    toolEvent(3, 'ACTIVE', 'swarm', addParams('scout')),
    {
      ...toolEvent(3, 'DONE', 'swarm', addParams('scout')),
      step_update: {
        ...toolEvent(3, 'DONE', 'swarm', addParams('scout')).step_update,
        tool_info: { error: { message: 'no' } },
      },
    },
  ]);
  assert.equal(rows.at(-1).status, 'failed');
  assert.equal(b.swarms.get(sessionId)?.members.size ?? 0, 0);
});

test('other swarm tools stay ordinary rows with readable titles', async (t) => {
  const { rows } = await liveSwarm(t, [
    toolEvent(3, 'DONE', 'swarm_wait', { since: 1 }),
    toolEvent(4, 'DONE', 'read_board', { since: 1 }),
    toolEvent(5, 'DONE', 'swarm', { action: 'status' }),
    toolEvent(6, 'DONE', 'swarm', { action: 'kill', name: 'scout' }),
    toolEvent(7, 'DONE', 'swarm', { action: 'models' }),
    toolEvent(8, 'DONE', 'post_message', { text: 'x' }),
    toolEvent(9, 'DONE', 'manage_task', { a: 1 }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.title, r.kind]),
    [
      ['Swarm: bekle', 'other'],
      ['Swarm: panoyu oku', 'other'],
      ['Swarm: durum', 'other'],
      ['Swarm: sonlandır (scout)', 'other'],
      ['Swarm: modeller', 'other'],
      ['Swarm: mesaj gönder', 'other'],
      ['manage_task', 'other'],
    ]
  );
});

test('an oversized reply is capped and keeps the newest posts', async (t) => {
  const board = jsonl([
    post(2, 'scout', 'ESKİ'),
    ...Array.from({ length: 6 }, (_, i) => post(3 + i, 'scout', 'x'.repeat(5000) + i)),
  ]);
  const { rows } = await liveSwarm(t, addEvents(3, 'scout', 1), { board });
  const text = reply(rows.filter((r) => r.toolCallId === 'agy-3').at(-1));
  assert.ok(text.length <= SWARM_REPLY_LIMIT + 8);
  assert.ok(!text.includes('ESKİ') && text.endsWith('5'));
});

test('swarm files are never read for a non-UUID native id', async (t) => {
  const run = await liveSwarm(t, addEvents(3, 'scout', 1));
  const { b, sessionId, updates, root } = { ...run, root: run.brainDirectory };
  await writeSwarm(root, '..', { board: jsonl([post(2, 'scout', '[done] x')]) }).catch(() => {});
  const before = updates.length;
  await b.syncSwarm(sessionId, '../../etc');
  await b.syncSwarm(sessionId, undefined);
  assert.equal(updates.length, before);
});

test('replay rebuilds swarm rows from the transcript, board and members', async (t) => {
  const transcript = jsonl([
    userRow(0, 'ekibi kur'),
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [
        // Transcript args are JSON-encoded strings.
        {
          name: 'swarm',
          args: {
            action: '"add"',
            name: '"scout"',
            brief: '"keşif görevi"',
            model: '"model-1"',
          },
        },
        { name: 'swarm', args: { action: '"status"' } },
        { name: 'swarm_wait', args: { since: '1' } },
      ],
    },
    { step_index: '2', type: 'GENERIC', content: addOutput('scout', 1) },
    { step_index: '3', type: 'GENERIC', content: '{"members":[]}' },
    { step_index: '4', type: 'GENERIC', content: '{}' },
  ]);
  const { b, sessionId, cwd, updates, brainDirectory } = await replaySetup(t, { transcript });
  await writeSwarm(brainDirectory, NATIVE, {
    board: jsonl([post(2, 'scout', '@coordinator [done] hazır')]),
    members: JSON.stringify({ members: { scout: { phase: 'RUNNING', killed: false } } }),
  });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  assert.deepEqual(
    rows.map((r) => [r.sessionUpdate, r.toolCallId, r.title, r.kind, r.status]),
    [
      ['tool_call', 'agy-replay-1-0', 'scout · Model One', 'subagent', 'in_progress'],
      ['tool_call', 'agy-replay-1-1', 'Swarm: durum', 'other', 'completed'],
      ['tool_call', 'agy-replay-1-2', 'Swarm: bekle', 'other', 'completed'],
      ['tool_call_update', 'agy-replay-1-0', undefined, undefined, 'completed'],
    ]
  );
  assert.equal(rows[0].rawInput.description, 'keşif görevi');
  assert.deepEqual(rows[1].rawInput, { action: 'status' });
  assert.equal(reply(rows[3]), '@coordinator [done] hazır');
});

test('replay without swarm files keeps the member running and still loads', async (t) => {
  const transcript = jsonl([
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"scout"', brief: '"b"' } }],
    },
    { step_index: '2', type: 'GENERIC', content: addOutput('scout', 1) },
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.status]),
    [['subagent', 'in_progress']]
  );
});

test('replay restores a brief the transcript cut from the full board text', async (t) => {
  const cutBrief = '"ilk satır\\nikinci \\"alıntı\\" \\u00fc\n<truncated 400 bytes>';
  const transcript = jsonl([
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"scout"', brief: cutBrief } }],
    },
    { step_index: '2', type: 'GENERIC', content: addOutput('scout', 7) },
  ]);
  const { b, sessionId, cwd, updates, brainDirectory } = await replaySetup(t, { transcript });
  await writeSwarm(brainDirectory, NATIVE, {
    board: jsonl([{ seq: 7, agent: 'coordinator', kind: 'brief', text: '@scout tam görev metni' }]),
  });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  assert.equal(rows[0].rawInput.description, 'ilk satır\nikinci "alıntı" ü…');
  assert.equal(rows[1].sessionUpdate, 'tool_call_update');
  assert.equal(rows[1].rawInput.description, 'tam görev metni');
});

test('loadSession adopts a TUI-started native conversation and replays its transcript', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-agy-tui-adopt-'));
  const directory = join(root, 'state');
  const brainDirectory = join(root, 'brain');
  const cwd = join(root, 'workspace');
  const tuiNativeId = '44444444-4444-4444-8444-444444444444';
  await mkdir(cwd, { recursive: true });
  await mkdir(join(brainDirectory, tuiNativeId, '.system_generated', 'logs'), { recursive: true });
  await writeFile(
    join(brainDirectory, tuiNativeId, '.system_generated', 'logs', 'transcript.jsonl'),
    jsonl([
      {
        step_index: '0',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Terminalden merhaba</USER_REQUEST>',
      },
      {
        step_index: '1',
        type: 'PLANNER_RESPONSE',
        content: 'Sohbette devam ediyoruz.',
      },
    ])
  );
  const updates = [];
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    brainDirectory,
    notify: (x) => updates.push(x.params.update),
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
  });
  t.after(async () => {
    await b.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const loaded = await b.loadSession({ sessionId: tuiNativeId, cwd });
  assert.equal(loaded.configOptions[0].currentValue, 'model-1');
  assert.equal(b.session(tuiNativeId).nativeId, tuiNativeId);
  assert.deepEqual(
    updates.map((u) => [u.sessionUpdate, u.content?.text]),
    [
      ['user_message_chunk', 'Terminalden merhaba'],
      ['agent_message_chunk', 'Sohbette devam ediyoruz.'],
    ]
  );
});

test('buildArgs forwards Antigravity orchestrator planner and executor settings', () => {
  const args = buildArgs({
    model: 'gemini-pro-orchestrator-neon',
    mode: 'default',
    orchestrator: {
      planner: 'gemini-4-neon-xhigh',
      executor: 'gemini-4-hydrogen-high',
    },
  });
  const settingsIdx = args.indexOf('--settings');
  assert.ok(settingsIdx >= 0);
  assert.deepEqual(JSON.parse(args[settingsIdx + 1]), {
    orchestrator: {
      planner: 'gemini-4-neon-xhigh',
      executor: 'gemini-4-hydrogen-high',
    },
  });
});

test('AntigravityBridge exposes collaboration_mode, syncs Orchestrator selection with model, and applies orchestrator defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-orch-'));
  const calls = [];
  const catalogOutput = [
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
    'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
    'gemini-pro-orchestrator-argon\tOrchestrator (Argon)',
  ].join('\n');
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    orchestratorConfig: {
      defaultMode: 'gemini-pro-orchestrator-neon',
      settings: {
        planner: 'gemini-4-neon-xhigh',
        executor: 'claude-sonnet-5-5-high',
      },
    },
    exec: (_cmd, _args, _opts, cb) => cb(null, catalogOutput),
    spawnProcess: (cmd, args) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          setImmediate(() => child.emit('close', 0));
          return true;
        },
      });
      child.stdin.on('data', () =>
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } }) +
              '\n'
          );
        })
      );
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await b.newSession({ cwd: directory });
  const modelOpt = created.configOptions.find((o) => o.id === 'model');
  const collabOpt = created.configOptions.find((o) => o.id === 'collaboration_mode');
  assert.equal(modelOpt?.currentValue, 'gemini-pro-orchestrator-neon');
  assert.equal(collabOpt?.currentValue, 'gemini-pro-orchestrator-neon');
  assert.deepEqual(
    collabOpt?.options.map((o) => o.value),
    [
      'standard',
      'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator',
      'gemini-pro-orchestrator-argon',
    ]
  );

  await b.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Planla' }] });
  const settingsIdx = calls[0].args.indexOf('--settings');
  assert.ok(settingsIdx >= 0);
  assert.deepEqual(JSON.parse(calls[0].args[settingsIdx + 1]), {
    orchestrator: {
      planner: 'gemini-4-neon-xhigh',
      executor: 'claude-sonnet-5-5-high',
    },
  });

  // Switching collaboration_mode back to standard restores the standard model.
  const backToStandard = await b.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'collaboration_mode',
    value: 'standard',
  });
  assert.equal(
    backToStandard.configOptions.find((o) => o.id === 'model')?.currentValue,
    'gemini-4-neon-high'
  );
  assert.equal(
    backToStandard.configOptions.find((o) => o.id === 'collaboration_mode')?.currentValue,
    'standard'
  );

  // Picking a different standard model then toggling orchestrator remembers the new standard model.
  await b.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'model',
    value: 'gemini-4-hydrogen-high',
  });
  const pickedOrch = await b.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'model',
    value: 'gemini-pro-orchestrator-argon',
  });
  assert.equal(
    pickedOrch.configOptions.find((o) => o.id === 'collaboration_mode')?.currentValue,
    'gemini-pro-orchestrator-argon'
  );
  const restored = await b.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'collaboration_mode',
    value: 'standard',
  });
  assert.equal(
    restored.configOptions.find((o) => o.id === 'model')?.currentValue,
    'gemini-4-hydrogen-high'
  );
});

test('buildArgs auto-allows built-in orkestra MCP tools when present in non-auto mode', () => {
  const args = buildArgs({
    model: 'gemini-4-neon-medium',
    mode: 'default',
    mcpServers: {
      'orkestra-subagents': { command: 'node', args: ['/mcp/sub.mjs'], disabled: false },
      'orkestra-widgets': { command: 'node', args: ['/mcp/wid.mjs'], disabled: false },
    },
  });
  const settingsIdx = args.indexOf('--settings');
  assert.ok(settingsIdx >= 0);
  const parsed = JSON.parse(args[settingsIdx + 1]);
  assert.deepEqual(parsed.permissions?.allow, [
    'mcp(orkestra-subagents/list_subagent_models)',
    'mcp(orkestra-subagents/run_subagent)',
    'mcp(orkestra-widgets/show_widget)',
  ]);

  const autoArgs = buildArgs({
    model: 'gemini-4-neon-medium',
    mode: 'auto',
    mcpServers: {
      'orkestra-subagents': { command: 'node', args: ['/mcp/sub.mjs'], disabled: false },
    },
  });
  assert.ok(!autoArgs.includes('--settings'));
});

test('extractExternalSubagentCall decodes quoted call_mcp_tool parameters and AntigravityBridge emits subagent updates', async (t) => {
  const ext = extractExternalSubagentCall({
    tool_name: 'call_mcp_tool',
    tool_info: {
      parameters: {
        ServerName: '"orkestra-subagents"',
        ToolName: '"run_subagent"',
        Arguments: JSON.stringify({
          provider: 'codex',
          model: 'gpt-6.2-sol',
          effort: 'high',
          role: '"GPT-6.2 Sol"',
          prompt: '"Selam ver"',
        }),
      },
    },
  });
  assert.deepEqual(ext, {
    provider: 'codex',
    model: 'gpt-6.2-sol',
    effort: 'high',
    role: 'GPT-6.2 Sol',
    prompt: 'Selam ver',
  });

  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-extsub-'));
  const updates = [];
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    notify: (msg) => {
      if (msg.method === 'session/update') updates.push(msg.params.update);
    },
    exec: (_cmd, _args, _opts, cb) => cb(null, 'gemini-4-neon-medium\tGemini 4 Neon (Medium)\n'),
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          setImmediate(() => child.emit('close', 0));
          return true;
        },
      });
      child.stdin.on('data', () =>
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({
              event: 'step_update',
              step_update: {
                step_index: 5,
                step_type: 'tool',
                state: 'RUNNING',
                tool_name: 'call_mcp_tool',
                tool_info: {
                  parameters: {
                    ToolName: '"run_subagent"',
                    Arguments: JSON.stringify({
                      provider: 'codex',
                      model: 'gpt-6.2-sol',
                      effort: 'medium',
                      role: 'GPT-6.2 Sol',
                      prompt: 'Selam ver',
                    }),
                  },
                },
              },
            }) +
              '\n' +
              JSON.stringify({
                event: 'result',
                result: { status: 'SUCCESS', response: 'Tamam.' },
              }) +
              '\n'
          );
        })
      );
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await b.newSession({ cwd: directory });
  await b.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Çalıştır' }] });
  const subUpdate = updates.find((u) => u.toolCallId === 'agy-5');
  assert.equal(subUpdate?._meta?.antigravity?.kind, 'subagent');
  assert.equal(subUpdate?._meta?.antigravity?.provider, 'codex');
  assert.equal(subUpdate?._meta?.antigravity?.model, 'GPT 6.2 Sol');
});

test('AntigravityBridge hot-reloads orchestrator-config.json across prompts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-orch-live-'));
  const calls = [];
  await writeFile(
    join(directory, 'orchestrator-config.json'),
    JSON.stringify({
      defaultMode: 'gemini-pro-orchestrator-neon',
      planner: 'gemini-4-neon-high',
      executor: 'gemini-4-hydrogen-medium',
    })
  );
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    exec: (_cmd, _args, _opts, cb) =>
      cb(
        null,
        'gemini-pro-orchestrator-neon\tOrchestrator (Neon)\ngemini-4-neon-high\tGemini 4 Neon (High)\n'
      ),
    spawnProcess: (cmd, args) => {
      calls.push({ cmd, args });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          setImmediate(() => child.emit('close', 0));
          return true;
        },
      });
      child.stdin.on('data', () =>
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } }) +
              '\n'
          );
        })
      );
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await b.newSession({ cwd: directory });
  await b.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'İlk tur' }] });

  await writeFile(
    join(directory, 'orchestrator-config.json'),
    JSON.stringify({
      defaultMode: 'gemini-pro-orchestrator-neon',
      planner: 'gemini-4-neon-xhigh',
      executor: 'claude-opus-5-5-high',
    })
  );
  await b.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'İkinci tur' }] });

  assert.equal(calls.length, 2);
  const firstSettings = JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]);
  const secondSettings = JSON.parse(calls[1].args[calls[1].args.indexOf('--settings') + 1]);
  assert.deepEqual(firstSettings.orchestrator, {
    planner: 'gemini-4-neon-high',
    executor: 'gemini-4-hydrogen-medium',
  });
  assert.deepEqual(secondSettings.orchestrator, {
    planner: 'gemini-4-neon-xhigh',
    executor: 'claude-opus-5-5-high',
  });
});

test('initialize advertises image, embeddedContext and steering capabilities', async (t) => {
  const { b } = await setup(t, []);
  const init = await b.initialize();
  assert.deepEqual(init.agentCapabilities.promptCapabilities, {
    image: true,
    embeddedContext: true,
  });
  assert.deepEqual(init._meta, { steering: { supported: true } });
});

test('materializePromptBlocks handles image, resource, resource_link, and validates inputs', async (t) => {
  const { b, sessionId, directory } = await setup(t, []);
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pdfBytes = Buffer.from('%PDF-1.4\ntest');

  await assert.rejects(() => b.materializePromptBlocks([], sessionId), /boş/);
  await assert.rejects(() => b.materializePromptBlocks('bad', sessionId), /boş/);
  await assert.rejects(
    () => b.materializePromptBlocks([{ type: 'text', text: 'hi' }], '../escape'),
    /Geçersiz oturum/
  );
  await assert.rejects(
    () => b.materializePromptBlocks([{ type: 'audio', data: 'x' }], sessionId),
    /desteklemiyor/
  );

  const materialized = await b.materializePromptBlocks(
    [
      { type: 'text', text: 'Görseli ve dosyaları incele.' },
      { type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: 'AQID', mimeType: 'image/webp' },
      {
        type: 'resource',
        resource: { uri: 'file:///notes.md', text: '# Notlar\nMerhaba' },
      },
      {
        type: 'resource',
        resource: {
          uri: 'file:///report.pdf',
          mimeType: 'application/pdf',
          blob: pdfBytes.toString('base64'),
        },
      },
      { type: 'resource_link', uri: 'file:///src/index.ts', name: 'index.ts' },
      { type: 'resource_link', name: 'README.md' },
    ],
    sessionId
  );

  assert.match(materialized, /Görseli ve dosyaları incele\./);
  assert.match(
    materialized,
    /\[Kullanıcı görsel ekledi: .*\.png \(MIME: image\/png\)\. Görseli incelemek için read_file aracını bu tam dosya yoluyla kullan\.\]/
  );
  assert.match(materialized, /\[Kullanıcı görsel ekledi: .*\.webp \(MIME: image\/webp\)\./);
  assert.match(materialized, /\[Ek kaynak: file:\/\/\/notes\.md\]\n# Notlar\nMerhaba/);
  assert.match(
    materialized,
    /\[Kullanıcı dosya ekledi: .*\.pdf \(URI: file:\/\/\/report\.pdf, MIME: application\/pdf\)\. Dosyayı incelemek için read_file aracını bu tam dosya yoluyla kullan\.\]/
  );
  assert.match(materialized, /\[Ek dosya: file:\/\/\/src\/index\.ts\]/);
  assert.match(materialized, /\[Ek dosya: README\.md\]/);

  const attachDir = join(directory, 'attachments', sessionId);
  const attachStat = await stat(attachDir);
  assert.equal(attachStat.mode & 0o777, 0o700);

  const imgMatch = /\[Kullanıcı görsel ekledi: ([^ ]+\.png)/.exec(materialized);
  assert.ok(imgMatch);
  const imgFile = await readFile(imgMatch[1]);
  assert.deepEqual(imgFile, pngBytes);
  assert.equal((await stat(imgMatch[1])).mode & 0o777, 0o600);

  const pdfMatch = /\[Kullanıcı dosya ekledi: ([^ ]+\.pdf)/.exec(materialized);
  assert.ok(pdfMatch);
  assert.deepEqual(await readFile(pdfMatch[1]), pdfBytes);
});

test('prompt materializes image and resource blocks into stdin payload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-attach-prompt-'));
  const written = [];
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          setImmediate(() => child.emit('close', 0));
          return true;
        },
      });
      child.stdin.on('data', (chunk) => {
        written.push(chunk.toString('utf8'));
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Tamam' } }) +
              '\n'
          );
        });
      });
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const { sessionId } = await b.newSession({ cwd: directory });
  const result = await b.prompt({
    sessionId,
    prompt: [
      { type: 'text', text: 'Buna bak' },
      { type: 'image', data: Buffer.from('img').toString('base64'), mimeType: 'image/jpeg' },
    ],
  });
  assert.deepEqual(result, { stopReason: 'end_turn' });
  const payload = JSON.parse(written.join('').trim());
  assert.equal(payload.event, 'user');
  assert.match(
    payload.message.content,
    /^Buna bak\n\n\[Kullanıcı görsel ekledi: .*\.jpg \(MIME: image\/jpeg\)\./
  );
});

test('steerSession injects NDJSON user event into active turn and returns promptRequired when idle', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-steer-'));
  const written = [];
  let child;
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    steerAckTimeoutMs: 2000,
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
    spawnProcess: () => {
      child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          setImmediate(() => child.emit('close', 0));
          return true;
        },
      });
      child.stdin.on('data', (chunk) => {
        written.push(chunk.toString('utf8'));
        // agy echoes a user_input step for every message it starts, the steered one included.
        setImmediate(() => {
          if (written.length === 1) {
            child.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
            child.stdout.write(
              stepUpdate({ step_index: 1, step_type: 'agent_response', text_delta: 'Tamam' })
            );
          } else {
            child.stdout.write(stepUpdate({ step_index: 2, step_type: 'user_input' }));
          }
        });
      });
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  });
  t.after(async () => {
    await b.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const { sessionId } = await b.newSession({ cwd: directory });
  assert.deepEqual(await b.steerSession({ sessionId, prompt: [{ type: 'text', text: 'boşta' }] }), {
    outcome: 'promptRequired',
  });

  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'ilk görev' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const steerResult = await b.steerSession({
    sessionId,
    prompt: [
      { type: 'text', text: 'ek yönlendirme' },
      { type: 'resource_link', uri: 'file:///foo.ts' },
    ],
  });
  assert.deepEqual(steerResult, { outcome: 'injected' });
  assert.equal(written.length, 2);
  const steeredPayload = JSON.parse(written[1].trim());
  assert.deepEqual(steeredPayload, {
    event: 'user',
    message: { content: 'ek yönlendirme\n[Ek dosya: file:///foo.ts]' },
  });

  child.stdout.write(
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Bitti' } }) + '\n'
  );
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  assert.deepEqual(await b.steerSession({ sessionId, prompt: [{ type: 'text', text: 'sonra' }] }), {
    outcome: 'promptRequired',
  });
});

test(
  'the ACP wire accepts _session/steering and returns promptRequired when no turn runs',
  { timeout: 5000 },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./acp-adapter.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    t.after(() => child.kill());
    const response = new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Adapter exited before steering response: ${code}`))
      );
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: '_session/steering',
        params: { sessionId: 'no-active-turn', prompt: [{ type: 'text', text: 'ping' }] },
      }) + '\n'
    );
    assert.deepEqual(await response, {
      jsonrpc: '2.0',
      id: 1,
      result: { outcome: 'promptRequired' },
    });
  }
);

function stepUpdate(step_update) {
  return JSON.stringify({ event: 'step_update', step_update }) + '\n';
}

function steerHarness(t, { steerAckTimeoutMs = 50 } = {}) {
  const children = [];
  return mkdtemp(join(tmpdir(), 'orkestra-acp-steer-')).then((directory) => {
    const b = new AntigravityBridge({
      cli: '/mock/agy',
      directory,
      steerAckTimeoutMs,
      exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          written: [],
          signals: [],
          kill: (signal) => {
            child.signals.push(signal);
            setImmediate(() => child.emit('close', signal === 'SIGINT' ? 130 : 143));
            return true;
          },
        });
        child.stdin.on('data', (chunk) => child.written.push(chunk.toString('utf8')));
        child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
        children.push(child);
        return child;
      },
    });
    t.after(async () => {
      await b.shutdown();
      await rm(directory, { recursive: true, force: true });
    });
    return { b, directory, children };
  });
}

test('steering into a turn that waits on background tasks is not reported as injected', async (t) => {
  // Regression: agy only reads the next stdin `user` line once the running message (including its
  // wait for background tasks) ends. The adapter used to answer `injected` right after the write,
  // so the runtime neither cancelled nor resent and the message vanished while the UI kept working.
  const { b, directory, children } = await steerHarness(t);
  const { sessionId } = await b.newSession({ cwd: directory });
  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'kareleri üret' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [agy] = children;
  agy.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
  agy.stdout.write(
    stepUpdate({ step_index: 1, step_type: 'tool', state: 'RUNNING', tool_name: 'run_command' })
  );
  agy.stdout.write(
    stepUpdate({ step_index: 2, step_type: 'agent_response', text_delta: 'Bitmesini bekliyorum.' })
  );
  await new Promise((resolve) => setImmediate(resolve));

  const steer = await b.steerSession({
    sessionId,
    prompt: [{ type: 'text', text: 'cevap versene' }],
  });
  assert.deepEqual(steer, { outcome: 'promptRequired' });
  assert.equal(agy.written.length, 2, 'the line was written but agy never started it');

  // The runtime's fallback cancels the turn; the process holding the unread line goes away.
  await b.cancel({ sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.deepEqual(agy.signals, ['SIGINT']);

  // The resent prompt runs on a fresh agy process that sees only the new message.
  const next = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'cevap versene' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 2);
  const [, fresh] = children;
  assert.equal(fresh.written.length, 1);
  assert.equal(JSON.parse(fresh.written[0]).message.content, 'cevap versene');
  fresh.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.deepEqual(await next, { stopReason: 'end_turn' });
});

test('a steered line still unread when the turn ends never runs as an unrequested turn', async (t) => {
  const { b, directory, children } = await steerHarness(t, { steerAckTimeoutMs: 5000 });
  const { sessionId } = await b.newSession({ cwd: directory });
  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'ilk' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [agy] = children;
  agy.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
  await new Promise((resolve) => setImmediate(resolve));

  const steer = b.steerSession({ sessionId, prompt: [{ type: 'text', text: 'ek' }] });
  await new Promise((resolve) => setImmediate(resolve));
  agy.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  assert.deepEqual(await steer, { outcome: 'promptRequired' });
  assert.deepEqual(agy.signals, ['SIGTERM'], 'the process holding the unread line is stopped');

  // Anything the discarded process still prints is ignored.
  const before = b.active.size;
  agy.stdout.write(stepUpdate({ step_index: 9, step_type: 'agent_response', text_delta: 'x' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.active.size, before);

  const next = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'ek' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 2);
  children[1].stdout.write(
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n'
  );
  assert.deepEqual(await next, { stopReason: 'end_turn' });
});

test('the echo of the prompt itself does not count as steering acceptance', async (t) => {
  const { b, directory, children } = await steerHarness(t);
  const { sessionId } = await b.newSession({ cwd: directory });
  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'ilk' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [agy] = children;
  const steer = b.steerSession({ sessionId, prompt: [{ type: 'text', text: 'ek' }] });
  await new Promise((resolve) => setImmediate(resolve));
  // agy echoes the original prompt only now; the steered line is still unread.
  agy.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
  assert.deepEqual(await steer, { outcome: 'promptRequired' });
  await b.cancel({ sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
});
