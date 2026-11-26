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
  extractAgyPlanEntries,
  extractExternalSubagentCall,
  FALLBACK_MODELS,
  ownedTaskProcesses,
  parseModels,
  parseProcessTable,
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

test('replay keeps uploaded images and upgrades legacy image paths', async (t) => {
  const { b, sessionId, cwd, updates, brainDirectory } = await replaySetup(t, { transcript: '' });
  const imageDir = join(b.directory, 'attachments', sessionId);
  await mkdir(imageDir, { recursive: true });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=';
  const imagePath = join(imageDir, '20cd6333-a693-485d-aaec-1aebc9328db6.png');
  await writeFile(imagePath, png, 'base64');
  const notice = `[Kullanıcı görsel ekledi: ${imagePath} (MIME: image/png). Görseli incelemek için read_file aracını bu tam dosya yoluyla kullan.]`;
  const ref = {
    id: '11d0e61b-0962-4ebb-8802-7a71327750b7',
    name: 'screen.png',
    mimeType: 'image/png',
  };
  await writeFile(
    join(brainDirectory, NATIVE, '.system_generated', 'logs', 'transcript.jsonl'),
    jsonl([
      userRow(
        0,
        `${notice}\nNew screenshot\n<orkestra_context><orkestra_attachments>${JSON.stringify([ref])}</orkestra_attachments></orkestra_context>`
      ),
      { type: 'PLANNER_RESPONSE', content: 'Got it' },
      userRow(2, `${notice}\nLegacy screenshot`),
    ])
  );
  await b.loadSession({ sessionId, cwd });

  const texts = updates
    .filter(({ sessionUpdate }) => sessionUpdate === 'user_message_chunk')
    .map(({ content }) => content.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /New screenshot/);
  assert.ok(texts[0].includes(JSON.stringify([ref])));
  assert.ok(!texts[0].includes(imagePath) && !texts[0].includes('data:image'));
  assert.equal(texts[1], `Legacy screenshot\n[@image](data:image/png;base64,${png})`);
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
// ACP SDK 1.x `ToolKind`: a tool_call with any other kind is rejected whole by the client.
const ACP_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
];
const assertAcpToolKinds = (rows) => {
  for (const row of rows)
    assert.ok(
      row.kind === undefined || ACP_TOOL_KINDS.includes(row.kind),
      `${row.toolCallId}: kind ${row.kind} is outside the ACP contract`
    );
};

test('swarm add becomes a sub-agent row carrying the task', async (t) => {
  const { rows } = await liveSwarm(t, addEvents(3, 'scout', 1));
  assert.equal(rows[0].sessionUpdate, 'tool_call');
  // ACP rejects a tool_call whose kind is outside its fixed set; the sub-agent kind rides in _meta.
  assertAcpToolKinds(rows);
  assert.equal(rows[0].kind, 'other');
  assert.equal(rows[0]._meta?.orkestra?.toolKind, 'subagent');
  assert.equal(rows[0]._meta?.antigravity?.kind, 'subagent');
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
      ['tool_call', 'agy-replay-1-0', 'scout · Model One', 'other', 'in_progress'],
      ['tool_call', 'agy-replay-1-1', 'Swarm: durum', 'other', 'completed'],
      ['tool_call', 'agy-replay-1-2', 'Swarm: bekle', 'other', 'completed'],
      ['tool_call_update', 'agy-replay-1-0', undefined, undefined, 'completed'],
    ]
  );
  assert.equal(rows[0].rawInput.description, 'keşif görevi');
  assertAcpToolKinds(rows);
  assert.deepEqual(rows[0]._meta, { orkestra: { toolKind: 'subagent' } });
  assert.equal(rows[1]._meta, undefined);
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
    rows.map((r) => [r.kind, r._meta?.orkestra?.toolKind, r.status]),
    [['other', 'subagent', 'in_progress']]
  );
});

test('replay keeps a member a live agy process still runs as a live detached row', async (t) => {
  const transcript = jsonl([
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"scout"', brief: '"b"' } }],
    },
    { step_index: '2', type: 'GENERIC', content: addOutput('scout', 1) },
  ]);
  const { b, sessionId, cwd, updates, brainDirectory } = await replaySetup(t, { transcript });
  // agy still runs this session (e.g. the client reconnected while a turn was going on).
  b.processes.set(sessionId, { closed: false, discarded: false });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  assert.deepEqual(
    rows.map((r) => [r.toolCallId, r.status, r._meta]),
    [['agy-replay-1-0', 'in_progress', { orkestra: { toolKind: 'subagent', detached: true } }]]
  );
  // The live process keeps syncing the replayed member to its real end.
  await writeSwarm(brainDirectory, NATIVE, {
    board: jsonl([post(2, 'scout', '@coordinator [done] hazır')]),
    members: JSON.stringify({ members: { scout: { phase: 'RUNNING', killed: false } } }),
  });
  await b.syncSwarm(sessionId, NATIVE);
  const last = updates.at(-1);
  assert.equal(last.toolCallId, 'agy-replay-1-0');
  assert.equal(last.status, 'completed');
});

test('replay without a live agy process leaves an unfinished member undetached', async (t) => {
  const transcript = jsonl([
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"scout"', brief: '"b"' } }],
    },
    { step_index: '2', type: 'GENERIC', content: addOutput('scout', 1) },
  ]);
  const { b, sessionId, cwd, updates, brainDirectory } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  // Orkestra closes such a row as "outcome unknown" (nothing follows it after the replay).
  assert.deepEqual(rows[0]._meta, { orkestra: { toolKind: 'subagent' } });
  await writeSwarm(brainDirectory, NATIVE, {
    board: jsonl([post(2, 'scout', '@coordinator [done] hazır')]),
  });
  const before = updates.length;
  await b.syncSwarm(sessionId, NATIVE);
  assert.equal(updates.length, before);
});

test('replay reports an external sub-agent call that never returned as outcome unknown', async (t) => {
  const transcript = jsonl([
    userRow(0, 'codex çalıştır'),
    {
      step_index: '1',
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [
        {
          name: 'call_mcp_tool',
          args: {
            ServerName: '"orkestra-subagents"',
            ToolName: '"run_subagent"',
            Arguments: JSON.stringify({ provider: 'codex', role: 'Codex', prompt: 'Selam' }),
          },
        },
      ],
    },
    // No GENERIC result: agy stopped before the call returned.
    userRow(2, 'sonra'),
  ]);
  const { b, sessionId, cwd, updates } = await replaySetup(t, { transcript });
  await b.loadSession({ sessionId, cwd });
  const rows = updates.filter((u) => u.toolCallId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Codex');
  assert.equal(rows[0].kind, 'other');
  assert.equal(rows[0].status, 'completed');
  assert.deepEqual(rows[0]._meta, { orkestra: { toolKind: 'subagent', statusUnknown: true } });
  assertAcpToolKinds(rows);
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

test('steerSession asks to queue during a turn (agy cannot read it) and returns promptRequired when idle', async (t) => {
  // agy reads the next stdin `user` line only after the turn's `result` (capture run2/run3 in
  // /tmp/orkestra-dalga2/agy-capture): writing the line mid-turn used to park it for 10 s, after
  // which the runtime stopped the turn to resend it. The adapter now writes nothing and asks the
  // runtime to hold the message until the turn ends.
  const { b, directory, children } = await steerHarness(t);
  const { sessionId } = await b.newSession({ cwd: directory });
  assert.deepEqual(await b.steerSession({ sessionId, prompt: [{ type: 'text', text: 'boşta' }] }), {
    outcome: 'promptRequired',
  });

  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'ilk görev' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [agy] = children;
  agy.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
  agy.stdout.write(stepUpdate({ step_index: 1, step_type: 'agent_response', text_delta: 'Tamam' }));
  await new Promise((resolve) => setImmediate(resolve));

  const started = Date.now();
  const steerResult = await b.steerSession({
    sessionId,
    prompt: [
      { type: 'text', text: 'ek yönlendirme' },
      { type: 'resource_link', uri: 'file:///foo.ts' },
    ],
  });
  assert.deepEqual(steerResult, {
    outcome: 'queueRequired',
    queueReason: 'antigravity-stream-json',
  });
  assert.ok(Date.now() - started < 1000, 'answers at once instead of waiting for an echo');
  assert.equal(agy.written.length, 1, 'nothing but the original prompt reaches agy');
  assert.deepEqual(agy.signals, [], 'the running turn is not stopped');

  agy.stdout.write(
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

function steerHarness(t) {
  const children = [];
  return mkdtemp(join(tmpdir(), 'orkestra-acp-steer-')).then((directory) => {
    const b = new AntigravityBridge({
      cli: '/mock/agy',
      directory,
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

test('a message sent during a turn is held and runs as the next prompt on the same agy', async (t) => {
  const { b, directory, children } = await steerHarness(t);
  const { sessionId } = await b.newSession({ cwd: directory });
  const turn = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'kareleri üret' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [agy] = children;
  agy.stdout.write(stepUpdate({ step_index: 0, step_type: 'user_input' }));
  agy.stdout.write(
    stepUpdate({ step_index: 1, step_type: 'tool', state: 'RUNNING', tool_name: 'run_command' })
  );
  await new Promise((resolve) => setImmediate(resolve));

  const steer = await b.steerSession({
    sessionId,
    prompt: [{ type: 'text', text: 'cevap versene' }],
  });
  assert.deepEqual(steer, { outcome: 'queueRequired', queueReason: 'antigravity-stream-json' });
  assert.equal(agy.written.length, 1);
  assert.deepEqual(agy.signals, []);

  agy.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.deepEqual(await turn, { stopReason: 'end_turn' });

  // The runtime sends the held message as the next prompt; the live process takes it.
  const next = b.prompt({ sessionId, prompt: [{ type: 'text', text: 'cevap versene' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 1, 'no process was discarded or restarted');
  assert.equal(agy.written.length, 2);
  assert.equal(JSON.parse(agy.written[1]).message.content, 'cevap versene');
  agy.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
  assert.deepEqual(await next, { stopReason: 'end_turn' });
  assert.deepEqual(agy.signals, []);
});

// --- Background tasks (fixtures captured from agy 1.5.17, see fixtures/) --------------------
const FIXTURE_NATIVE = '00000000-0000-4000-8000-0000000000a1';
const ACP_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
const ACP_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url);
async function streamFixture(name) {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8')).events.map((e) => e.event);
}
async function transcriptFixture(name) {
  return (await readFile(fixtureUrl(name), 'utf8')).split('\n').filter(Boolean);
}
async function until(predicate, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function assertAcpLegal(updates) {
  for (const u of updates) {
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue;
    if (u.kind !== undefined) assert.ok(ACP_KINDS.has(u.kind), `illegal kind ${u.kind}`);
    if (u.status !== undefined) assert.ok(ACP_STATUSES.has(u.status), `illegal status ${u.status}`);
  }
}
async function backgroundHarness(t, { processes } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-agy-bg-'));
  const directory = join(root, 'state'),
    brainDirectory = join(root, 'brain'),
    cwd = join(root, 'cwd');
  await mkdir(directory, { recursive: true });
  await mkdir(cwd);
  const system = join(brainDirectory, FIXTURE_NATIVE, '.system_generated');
  await mkdir(join(system, 'logs'), { recursive: true });
  await mkdir(join(system, 'tasks'), { recursive: true });
  const transcriptPath = join(system, 'logs', 'transcript.jsonl');
  const children = [],
    updates = [];
  const interrupted = (await streamFixture('agy-background-sigint-stream.json')).at(-1);
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    brainDirectory,
    backgroundPollMs: 10,
    ...(processes
      ? {
          platform: 'darwin',
          listProcesses: processes.list,
          signalProcess: processes.signal,
          taskKillGraceMs: 5,
        }
      : {}),
    notify: (x) => updates.push(x.params.update),
    exec: (_cmd, _args, _opts, cb) => cb(null, 'model-1\tModel One\n'),
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        ...(processes ? { pid: processes.agyPid } : {}),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        written: [],
        signals: [],
        // Like agy 1.5.17: SIGINT ends the turn with `ERROR interrupted`, then the process exits.
        kill: (signal) => {
          child.signals.push(signal);
          setImmediate(() => {
            if (signal === 'SIGINT') child.stdout.write(JSON.stringify(interrupted) + '\n');
            setImmediate(() => child.emit('close', 1));
          });
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
    await rm(root, { recursive: true, force: true });
  });
  const { sessionId } = await b.newSession({ cwd });
  b.session(sessionId).nativeId = FIXTURE_NATIVE;
  const emit = (child, events) => {
    for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
  };
  const appendTranscript = async (rows) => {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(transcriptPath, rows.map((r) => r + '\n').join(''));
  };
  return {
    b,
    sessionId,
    updates,
    children,
    emit,
    appendTranscript,
    taskLog: join(system, 'tasks', 'task-2.log'),
  };
}
const isBackgroundRow = (u) =>
  u.toolCallId === 'agy-2' && u._meta?.orkestra?.backgroundTask !== undefined;

test('a background task becomes a live execute row, shows the held reply and log, then completes', async (t) => {
  const h = await backgroundHarness(t);
  const events = await streamFixture('agy-background-stream.json');
  const rows = await transcriptFixture('agy-background-transcript.jsonl');
  const turn = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'arka plan' }],
  });
  await until(() => h.children.length === 1, 'agy start');
  const [agy] = h.children;
  // Up to the tool step that agy keeps ACTIVE while the task runs in the background.
  h.emit(agy, events.slice(0, 4));
  await h.appendTranscript(rows.slice(0, 4)); // user input, tool call, RUNNING, held reply
  await writeFile(h.taskLog, 'frame 1/3\n');

  await until(
    () => h.updates.some((u) => isBackgroundRow(u) && u.status === 'in_progress'),
    'background row'
  );
  const running = h.updates.find((u) => isBackgroundRow(u) && u.status === 'in_progress');
  assert.equal(running.sessionUpdate, 'tool_call_update');
  assert.equal(running.kind, 'execute');
  assert.equal(running.title, 'sleep 37 && echo bg-finished');
  assert.equal(running.rawInput.description, 'Arka planda çalışıyor: Start background sleep task');
  assert.deepEqual(running._meta.orkestra.backgroundTask, {
    taskId: `${FIXTURE_NATIVE}/task-2`,
    state: 'running',
  });
  // The agent's reply that the stream holds back until the task ends is shown now.
  await until(
    () =>
      h.updates.some(
        (u) => u.content?.text === 'Arka plan görevi başlatıldı ve arka planda çalışıyor.'
      ),
    'mirrored reply'
  );
  // The task log is the row's live output.
  await until(
    () =>
      h.updates.some(
        (u) => u.toolCallId === 'agy-2' && u.content?.[0]?.content?.text === 'frame 1/3'
      ),
    'log tail'
  );
  await writeFile(h.taskLog, 'frame 1/3\nframe 2/3\n');
  await until(
    () => h.updates.some((u) => u.content?.[0]?.content?.text === 'frame 1/3\nframe 2/3'),
    'log tail update'
  );

  // The task ends: agy closes the tool step and releases the held steps and the result.
  h.emit(agy, events.slice(4));
  assert.deepEqual(await turn, { stopReason: 'end_turn' });
  const done = h.updates.filter(isBackgroundRow).at(-1);
  assert.equal(done.status, 'completed');
  assert.equal(done.kind, 'execute');
  assert.equal(done.rawInput.description, 'Arka plan görevi bitti: Start background sleep task');
  assert.equal(done._meta.orkestra.backgroundTask.state, 'completed');
  assert.match(done.content[0].content.text, /bg-finished/);
  const texts = h.updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content.text);
  assert.equal(
    texts.filter((text) => text.startsWith('Arka plan görevi başlatıldı')).length,
    1,
    'the held reply is not repeated when the stream releases it'
  );
  assert.ok(texts.includes('done\n'));
  assertAcpLegal(h.updates);
});

test('a message sent during a background task is declined at once; the stop is explained on the row', async (t) => {
  const h = await backgroundHarness(t);
  const events = await streamFixture('agy-background-sigint-stream.json');
  const rows = await transcriptFixture('agy-background-sigint-transcript.jsonl');
  const turn = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'arka plan' }],
  });
  await until(() => h.children.length === 1, 'agy start');
  const [agy] = h.children;
  h.emit(agy, events.slice(0, 4));
  await h.appendTranscript(rows);
  await until(() => h.updates.some(isBackgroundRow), 'background row');

  const started = Date.now();
  const steer = await h.b.steerSession({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'şimdi şunu yap' }],
  });
  // Stopping the turn would orphan the task, so the adapter asks the runtime to hold the message.
  assert.deepEqual(steer, { outcome: 'queueRequired', queueReason: 'antigravity-stream-json' });
  assert.ok(Date.now() - started < 1000, 'no wait for an acknowledgement agy never sends');
  assert.equal(agy.written.length, 1, 'no line is parked in agy stdin');
  assert.deepEqual(agy.signals, [], 'steering never stops a turn that waits on a background task');

  // The user can still stop the turn explicitly.
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.deepEqual(agy.signals, ['SIGINT']);
  const stopped = h.updates.filter(isBackgroundRow).at(-1);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped._meta.orkestra.backgroundTask.state, 'stopped');
  assert.equal(
    stopped.rawInput.description,
    'Arka plan görevi durduruldu: Background sleep command'
  );
  assert.match(stopped.content[0].content.text, /^Tur durduruldu\./);
  assert.match(stopped.content[0].content.text, /komut kendi başına çalışmayı sürdürebilir/);
  assertAcpLegal(h.updates);

  const next = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'şimdi şunu yap' }],
  });
  await until(() => h.children.length === 2, 'fresh agy');
  assert.equal(JSON.parse(h.children[1].written[0]).message.content, 'şimdi şunu yap');
  h.emit(h.children[1], [{ event: 'result', result: { status: 'SUCCESS' } }]);
  assert.deepEqual(await next, { stopReason: 'end_turn' });
});

test('stopping a turn that waits on a background task says the task is no longer tracked', async (t) => {
  const h = await backgroundHarness(t);
  const events = await streamFixture('agy-background-sigint-stream.json');
  const rows = await transcriptFixture('agy-background-sigint-transcript.jsonl');
  const turn = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'arka plan' }],
  });
  await until(() => h.children.length === 1, 'agy start');
  h.emit(h.children[0], events.slice(0, 4));
  await h.appendTranscript(rows);
  await until(() => h.updates.some(isBackgroundRow), 'background row');
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  const stopped = h.updates.filter(isBackgroundRow).at(-1);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.content[0].content.text, /^Tur durduruldu\./);
});

// `ps` as captured in run4-sigint: agy 77493 runs the task as `zsh -c <CommandLine>` (77566),
// whose `sleep` (77572) is the real work. 77600 is an MCP server agy also started; 88001 is an
// unrelated process with the same command line that agy did not start.
const SIGINT_PS = [
  '  501     1   501 /sbin/launchd',
  '77493   600 77493 /usr/local/bin/agy --input-format stream-json --output-format stream-json',
  '77566 77493 77493 zsh -c sleep 41 && echo bg-finished',
  '77572 77566 77493 sleep 41',
  '77600 77493 77493 node /mcp/server.mjs',
  '88001     1 88001 zsh -c sleep 41 && echo bg-finished',
].join('\n');
const SIGINT_COMMAND = 'sleep 41 && echo bg-finished';

test("only the stopped task's own process tree is picked from the process table", () => {
  const table = parseProcessTable(SIGINT_PS);
  assert.deepEqual(table[2], {
    pid: 77566,
    ppid: 77493,
    pgid: 77493,
    args: 'zsh -c ' + SIGINT_COMMAND,
  });
  const task = { command: SIGINT_COMMAND };
  const owned = ownedTaskProcesses(table, 77493, [task]);
  assert.deepEqual(owned.tasks, [task]);
  // Descendants first; no process group: the shell shares agy's group.
  assert.deepEqual(
    owned.trees.map((tree) => [tree.root, tree.members.map((m) => m.pid), tree.group]),
    [[77566, [77572, 77566], undefined]]
  );
  // A task shell in its own process group is ended as a group too.
  const own = parseProcessTable(SIGINT_PS.replace('77566 77493 77493', '77566 77493 77566'));
  assert.equal(ownedTaskProcesses(own, 77493, [task]).trees[0].group, 77566);
});

test('a task whose processes cannot be proven its own is left alone', () => {
  const table = parseProcessTable(SIGINT_PS);
  const found = (tasks, pid = 77493) => ownedTaskProcesses(table, pid, tasks).trees.length;
  // Another command, another agy, a multi-line command, no command.
  assert.equal(found([{ command: 'sleep 41' }]), 0);
  assert.equal(found([{ command: SIGINT_COMMAND }], 12345), 0);
  assert.equal(found([{ command: 'sleep 41 &&\necho bg-finished' }]), 0);
  assert.equal(found([{ command: '' }, {}]), 0);
  // Two tracked tasks with this command but only one such child: ambiguous, nothing is picked.
  assert.equal(found([{ command: SIGINT_COMMAND }, { command: SIGINT_COMMAND }]), 0);
});

async function startBackgroundTurn(h) {
  const events = await streamFixture('agy-background-sigint-stream.json');
  const rows = await transcriptFixture('agy-background-sigint-transcript.jsonl');
  const turn = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [{ type: 'text', text: 'arka plan' }],
  });
  await until(() => h.children.length === 1, 'agy start');
  h.emit(h.children[0], events.slice(0, 4));
  await h.appendTranscript(rows);
  await until(() => h.updates.some(isBackgroundRow), 'background row');
  // Wrapped: an async function returning the promise itself would wait for the turn to end.
  return { turn };
}

test("stopping a turn ends its background task's processes and says so", async (t) => {
  const signals = [];
  let shellAlive = true;
  // After SIGTERM the shell is gone; its `sleep`, now an orphan, ignores SIGTERM.
  const orphaned = SIGINT_PS.replace(/^77566 .*\n/m, '').replace('77572 77566', '77572     1');
  const h = await backgroundHarness(t, {
    processes: {
      agyPid: 77493,
      list: async () => parseProcessTable(shellAlive ? SIGINT_PS : orphaned),
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === 77566) shellAlive = false;
      },
    },
  });
  const { turn } = await startBackgroundTurn(h);
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  // The tree was read while agy still parented it; agy itself only gets its usual SIGINT.
  assert.deepEqual(h.children[0].signals, ['SIGINT']);
  const stopped = h.updates.filter(isBackgroundRow).at(-1);
  assert.equal(stopped.status, 'failed');
  assert.match(
    stopped.content[0].content.text,
    /^Tur durduruldu\. Bu arka plan görevinin komutu da/
  );
  await until(() => signals.length === 3, 'escalation');
  // Only the survivor that is still the same process gets SIGKILL; agy, its MCP server and the
  // look-alike outside agy are never signalled.
  assert.deepEqual(signals, [
    [77572, 'SIGTERM'],
    [77566, 'SIGTERM'],
    [77572, 'SIGKILL'],
  ]);
});

test('closing a conversation is not a Stop: its background task keeps running', async (t) => {
  const signals = [];
  const h = await backgroundHarness(t, {
    processes: {
      agyPid: 77493,
      list: async () => parseProcessTable(SIGINT_PS),
      signal: (pid, signal) => signals.push([pid, signal]),
    },
  });
  await startBackgroundTurn(h);
  await h.b.closeSession({ sessionId: h.sessionId });
  assert.deepEqual(signals, []);
  const stopped = h.updates.filter(isBackgroundRow).at(-1);
  assert.match(stopped.content[0].content.text, /kendi başına çalışmayı sürdürebilir/);
});

test(
  'a real task tree is found under its parent and ended after the parent got SIGINT',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  async (t) => {
    const { spawn: spawnChild } = await import('node:child_process');
    const command = `sleep 37 && echo orkestra-task-${process.pid}`;
    // Stands in for agy: starts the task shell like agy does, prints its pid and waits.
    const script =
      `const c=require('node:child_process').spawn('/bin/sh',['-c',${JSON.stringify(command)}],` +
      `{stdio:'ignore'});process.stdout.write(c.pid+'\\n');` +
      `process.on('SIGINT',()=>process.exit(1));setInterval(()=>{},1000);`;
    const agy = spawnChild(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const shellPid = await new Promise((resolve) =>
      agy.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())))
    );
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let owned;
    t.after(() => {
      const pids = [agy.pid, shellPid, ...(owned?.trees[0]?.members.map((m) => m.pid) ?? [])];
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const b = new AntigravityBridge({ cli: '/mock/agy', taskKillGraceMs: 50 });
    const proc = { child: agy, backgroundTasks: new Map([['t', { command }]]) };
    // Until the shell has started its `sleep`.
    for (let i = 0; i < 100; i++) {
      owned = await b.findTaskProcesses(proc);
      if (owned?.trees[0]?.members.length > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(owned?.trees[0]?.members.length > 1, 'task tree found');
    const pids = owned.trees[0].members.map((m) => m.pid);
    assert.equal(pids.at(-1), shellPid);
    assert.ok(!pids.includes(agy.pid));
    agy.kill('SIGINT');
    b.terminateTaskProcesses(owned.trees);
    const deadline = Date.now() + 3000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(pids.filter(alive), []);
  }
);

test('an interrupted foreground tool is closed as failed instead of being left running', async (t) => {
  const h = await backgroundHarness(t);
  const events = await streamFixture('agy-background-sigint-stream.json');
  const turn = h.b.prompt({ sessionId: h.sessionId, prompt: [{ type: 'text', text: 'x' }] });
  await until(() => h.children.length === 1, 'agy start');
  // No transcript row: the command never went to the background.
  h.emit(h.children[0], events.slice(0, 4));
  await until(() => h.updates.some((u) => u.toolCallId === 'agy-2'), 'tool row');
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  const last = h.updates.filter((u) => u.toolCallId === 'agy-2').at(-1);
  assert.equal(last.status, 'failed');
  assert.equal(h.updates.filter(isBackgroundRow).length, 0);
});

test('replay shows a finished background task with its result and a stopped one as stopped', async (t) => {
  for (const [fixture, state, status, text] of [
    ['agy-background-transcript.jsonl', 'completed', 'completed', /bg-finished/],
    ['agy-background-sigint-transcript.jsonl', 'stopped', 'failed', /bitişini kaydetmedi/],
  ]) {
    const transcript = (await transcriptFixture(fixture)).join('\n') + '\n';
    const { b, sessionId, cwd, updates } = await replaySetup(t, {
      nativeId: FIXTURE_NATIVE,
      transcript,
    });
    await b.loadSession({ sessionId, cwd });
    const rows = updates.filter((u) => u._meta?.orkestra?.backgroundTask);
    assert.equal(rows.length, 1, fixture);
    const [row] = rows;
    assert.equal(row.sessionUpdate, 'tool_call');
    assert.equal(row.toolCallId, 'agy-replay-1-0');
    assert.equal(row.kind, 'execute');
    assert.equal(
      row.title,
      'sleep ' + (state === 'completed' ? '37' : '41') + ' && echo bg-finished'
    );
    assert.equal(row.status, status);
    assert.equal(row._meta.orkestra.backgroundTask.state, state);
    assert.match(row.content[0].content.text, text);
    assertAcpLegal(updates);
  }
});

test('extractAgyPlanEntries maps update_steps tool calls into ACP plan entries', () => {
  assert.equal(extractAgyPlanEntries('run_command', { CommandLine: 'ls' }), null);
  assert.deepEqual(
    extractAgyPlanEntries('update_steps', {
      steps: [
        { title: 'Hatayı yakala', status: 'in_progress' },
        { title: 'Kodu incele', status: 'pending' },
        { title: 'Test et', status: 'done' },
      ],
    }),
    [
      { content: 'Hatayı yakala', status: 'in_progress', priority: 'medium' },
      { content: 'Kodu incele', status: 'pending', priority: 'medium' },
      { content: 'Test et', status: 'completed', priority: 'medium' },
    ]
  );
});
