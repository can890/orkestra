// agy acp taşıma katmanı: gerçek agy 1.5.17 yakalamalarından (run7/run8/run11/run15-run18)
// kurulmuş, sentetik kimlikli sahte bir `agy acp` alt süreciyle köprü testleri.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityBridge } from './acp-adapter.mjs';
import {
  acpToolStep,
  buildAcpArgs,
  isBuiltinMcpPermission,
  isSpawnMessageOf,
  isSubagentCancelledMessage,
  normalizeTransport,
  parseCreatedSubagent,
  permissionResponse,
  probeAgyAcp,
  subagentOfToolCallId,
  subagentToolTitle,
} from './agy-acp-transport.mjs';

const NATIVE = '11111111-2222-4333-8444-555555555555';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Sahte `agy acp` (ve gerekirse stream-json) süreci. `acp` argümanı olan her süreç JSON-RPC konuşur.
function fakeAgy({ resume = true, initialize = 'ok', newSessionId = NATIVE, onRequest } = {}) {
  const spawns = [];
  const spawnProcess = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 7000 + spawns.length,
      args,
      opts,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      requests: [],
      notifications: [],
      signals: [],
      closed: false,
      kill(signal) {
        child.signals.push(signal);
        if (!child.closed) {
          child.closed = true;
          setImmediate(() => child.emit('close', null, signal));
        }
        return true;
      },
      send(message) {
        child.stdout.write(JSON.stringify(message) + '\n');
      },
      update(update, sessionId = NATIVE) {
        child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
      },
      respond(id, result) {
        child.send({ jsonrpc: '2.0', id, result });
      },
      fail(id, message, code = -32603) {
        child.send({ jsonrpc: '2.0', id, error: { code, message } });
      },
      prompts() {
        return child.requests.filter((r) => r.method === 'session/prompt');
      },
      clientResponses: [],
      ask(id, method, params) {
        child.send({ jsonrpc: '2.0', id, method, params });
      },
    });
    spawns.push(child);
    child.stdin.on('finish', () => {
      if (!child.closed) {
        child.closed = true;
        setImmediate(() => child.emit('close', 0));
      }
    });
    if (!args.includes('acp')) return child; // stream-json: hiçbir şey yazmaz
    createInterface({ input: child.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === undefined) {
        child.clientResponses.push(m);
        return;
      }
      if (m.id === undefined) {
        child.notifications.push(m);
        onRequest?.(child, m);
        return;
      }
      child.requests.push(m);
      if (onRequest?.(child, m) === 'handled') return;
      switch (m.method) {
        case 'initialize':
          if (initialize === 'error') child.fail(m.id, 'no acp');
          else if (initialize === 'silent') return;
          else
            child.respond(m.id, {
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: resume ? { resume: {} } : {} },
            });
          return;
        case 'session/new':
          child.respond(m.id, { sessionId: newSessionId });
          return;
        case 'session/prompt':
          return; // testler yanıtlar
        default:
          child.respond(m.id, {});
      }
    });
    return child;
  };
  return { spawns, spawnProcess, acp: () => spawns.filter((c) => c.args.includes('acp')) };
}

async function harness(t, { fake = fakeAgy(), transport = 'acp', extra = {}, mode } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-agy-acp-test-'));
  const brainDirectory = join(directory, 'brain');
  const updates = [];
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
    brainDirectory,
    transport,
    backgroundPollMs: 10,
    steerAcceptTimeoutMs: 300,
    acpCancelGraceMs: 200,
    notify: (x) => updates.push(x.params.update),
    exec: (_cmd, _args, _opts, cb) =>
      cb(null, 'model-1\tModel One\ngemini-pro-orchestrator\tOrch\n'),
    spawnProcess: fake.spawnProcess,
    ...extra,
  });
  t.after(async () => {
    await b.shutdown();
    for (const child of fake.spawns) if (!child.closed) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  const { sessionId } = await b.newSession({ cwd: directory });
  if (mode) await b.setSessionConfigOption({ sessionId, configId: 'mode', value: mode });
  return { b, sessionId, updates, fake, directory, brainDirectory };
}
const text = (value) => [{ type: 'text', text: value }];
// Başlayan bir turun alt süreci ve ilk session/prompt isteği.
async function startTurn(h, prompt = 'work') {
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text(prompt) });
  await until(() => h.fake.acp().at(-1)?.prompts().length >= 1, 'first prompt');
  const child = h.fake.acp().at(-1);
  return { result, child, first: child.prompts()[0] };
}
const settledState = async (promise) => {
  let state = 'pending';
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  );
  await tick(20);
  return state;
};

test('transport names are normalized and default to auto', () => {
  assert.equal(normalizeTransport('ACP'), 'acp');
  assert.equal(normalizeTransport('stream-json'), 'stream-json');
  assert.equal(normalizeTransport(undefined), 'auto');
  assert.equal(normalizeTransport('nonsense'), 'auto');
});

test('acp args put --settings before the subcommand and bypass only in auto mode', () => {
  assert.deepEqual(buildAcpArgs({ mode: 'default' }, undefined), ['acp']);
  assert.deepEqual(buildAcpArgs({ mode: 'auto' }, { a: 1 }), [
    '--settings',
    '{"a":1}',
    'acp',
    '--dangerously-skip-permissions',
  ]);
});

test('probe: answers initialize -> true; missing binary, error, silence or garbage -> false', async () => {
  assert.equal(await probeAgyAcp({ cli: '/x', spawnProcess: fakeAgy().spawnProcess }), true);
  assert.equal(
    await probeAgyAcp({
      cli: '/x',
      spawnProcess: () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    }),
    false
  );
  const erroring = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  assert.equal(await probeAgyAcp({ cli: '/x', spawnProcess: erroring }), false);
  assert.equal(
    await probeAgyAcp({
      cli: '/x',
      spawnProcess: fakeAgy({ initialize: 'silent' }).spawnProcess,
      timeoutMs: 50,
    }),
    false
  );
  assert.equal(
    await probeAgyAcp({ cli: '/x', spawnProcess: fakeAgy({ initialize: 'error' }).spawnProcess }),
    false
  );
  assert.equal(await probeAgyAcp({ cli: '', spawnProcess: fakeAgy().spawnProcess }), false);
});

test('auto transport probes once, caches per agy binary and uses acp', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-agy-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'agy');
  await writeFile(cli, 'binary');
  const fake = fakeAgy();
  const make = () =>
    new AntigravityBridge({ cli, directory, transport: 'auto', spawnProcess: fake.spawnProcess });
  assert.equal(await make().probeAcp(), true);
  assert.equal(fake.spawns.length, 1);
  assert.equal(await make().probeAcp(), true, 'second adapter process reads the cache');
  assert.equal(fake.spawns.length, 1);
  await writeFile(cli, 'updated binary');
  assert.equal(await make().probeAcp(), true);
  assert.equal(fake.spawns.length, 2, 'a changed agy binary is probed again');
  const cache = JSON.parse(await readFile(join(directory, 'agy-acp-probe.json'), 'utf8'));
  assert.equal(cache.supported, true);
});

test('auto transport falls back to stream-json when agy acp is unavailable', async (t) => {
  const fake = fakeAgy({ initialize: 'error' });
  const h = await harness(t, { fake, transport: 'auto' });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  await until(() => fake.spawns.some((c) => c.args.includes('--input-format')), 'stream-json');
  assert.ok(fake.spawns.at(-1).args.includes('stream-json'));
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
});

test('an explicit stream-json choice never starts agy acp', async (t) => {
  const fake = fakeAgy();
  const h = await harness(t, { fake, transport: 'stream-json' });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  assert.equal(fake.spawns.length, 1);
  assert.ok(!fake.spawns[0].args.includes('acp'));
  await h.b.cancel({ sessionId: h.sessionId });
  await result;
});

test('orchestrator sessions run on stream-json with their --settings', async (t) => {
  const fake = fakeAgy();
  const h = await harness(t, {
    fake,
    extra: {
      orchestratorConfig: {
        settings: { planner: 'gemini-4-argon-low', executor: 'gemini-4-hydrogen-low' },
      },
    },
  });
  await h.b.setSessionConfigOption({
    sessionId: h.sessionId,
    configId: 'model',
    value: 'gemini-pro-orchestrator',
  });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  const args = fake.spawns[0].args;
  assert.ok(args.includes('--input-format'));
  assert.match(args[args.indexOf('--settings') + 1], /gemini-4-argon-low/);
  assert.deepEqual(await h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') }), {
    outcome: 'queueRequired',
    queueReason: 'antigravity-orchestrator',
  });
  await h.b.cancel({ sessionId: h.sessionId });
  await result;
});

test('a plain turn: new conversation, model, mode, text, tool rows and usage', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h, 'hello');
  const methods = child.requests.map((r) => r.method);
  assert.deepEqual(methods, [
    'initialize',
    'session/new',
    'session/set_model',
    'session/set_mode',
    'session/prompt',
  ]);
  assert.equal(child.requests[2].params.modelId, 'model-1');
  assert.equal(child.requests[3].params.modeId, 'default');
  assert.deepEqual(child.requests[1].params.mcpServers, []);
  assert.equal(first.params.sessionId, NATIVE);
  assert.deepEqual(first.params.prompt, text('hello'));
  assert.equal(h.b.session(h.sessionId).nativeId, NATIVE);
  child.update({ sessionUpdate: 'config_option_update', configOptions: [] });
  child.update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
  child.update({ sessionUpdate: 'usage_update', used: 100, size: 1000 });
  child.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Running' },
  });
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    name: 'run_command',
    args: { CommandLine: 'echo a' },
    rawInput: { CommandLine: 'echo a' },
    status: 'in_progress',
    kind: 'execute',
    title: 'echo a',
  });
  child.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: 'completed',
    rawOutput: { output: 'Command exited with code 0.\n\nCommand output:\na\n', exit_code: 0 },
  });
  child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } });
  await until(() => h.updates.length >= 5, 'updates');
  child.respond(first.id, { stopReason: 'end_turn', usage: { totalTokens: 5 } });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
  const kinds = h.updates.map((u) => u.sessionUpdate);
  assert.ok(
    !kinds.includes('config_option_update') && !kinds.includes('available_commands_update')
  );
  assert.deepEqual(
    h.updates.find((u) => u.sessionUpdate === 'usage_update'),
    {
      sessionUpdate: 'usage_update',
      used: 100,
      size: 1000,
    }
  );
  const tool = h.updates.filter((u) => u.toolCallId === 'agy-acp-1');
  assert.equal(tool[0].sessionUpdate, 'tool_call');
  assert.equal(tool[0].title, 'run_command');
  assert.deepEqual(tool[0].rawInput, { CommandLine: 'echo a' });
  assert.equal(tool.at(-1).status, 'completed');
  assert.match(tool.at(-1).rawOutput, /Command output/);
  const texts = h.updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content.text);
  assert.deepEqual(texts, ['Running', '\n\n', 'Done']);
});

test('auto mode starts agy acp with the bypass flag; plan mode is set on the session', async (t) => {
  const auto = await harness(t, { mode: 'auto' });
  const a = await startTurn(auto);
  assert.ok(a.child.args.includes('--dangerously-skip-permissions'));
  assert.ok(!a.child.requests.some((r) => r.method === 'session/set_mode'));
  a.child.respond(a.first.id, { stopReason: 'end_turn' });
  await a.result;
  const plan = await harness(t, { mode: 'plan' });
  const p = await startTurn(plan);
  assert.ok(!p.child.args.includes('--dangerously-skip-permissions'));
  assert.equal(p.child.requests.find((r) => r.method === 'session/set_mode').params.modeId, 'plan');
  p.child.respond(p.first.id, { stopReason: 'end_turn' });
  await p.result;
});

test('a steered message joins the running turn; the turn ends with the last prompt', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  const steer = h.b.steerSession({ sessionId: h.sessionId, prompt: text('also echo steer-ok') });
  await until(() => child.prompts().length === 2, 'steer prompt');
  const second = child.prompts()[1];
  assert.deepEqual(second.params.prompt, text('also echo steer-ok'));
  // agy (run8): the earlier prompt returns end_turn as soon as the new one joins.
  child.respond(first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await steer, { outcome: 'injected' });
  assert.equal(await settledState(result), 'pending', 'one user-visible turn spans the chain');
  child.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'steer-ok' },
  });
  child.respond(second.id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
  assert.equal(child.prompts().length, 2, 'each message sent exactly once');
  assert.ok(!child.notifications.some((n) => n.method === 'session/cancel'));
  assert.deepEqual(await h.b.steerSession({ sessionId: h.sessionId, prompt: text('late') }), {
    outcome: 'promptRequired',
  });
  assert.equal(child.prompts().length, 2);
});

test('two steers in a row both join and the turn waits for the last', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  const s1 = h.b.steerSession({ sessionId: h.sessionId, prompt: text('one') });
  await until(() => child.prompts().length === 2);
  child.respond(first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await s1, { outcome: 'injected' });
  const s2 = h.b.steerSession({ sessionId: h.sessionId, prompt: text('two') });
  await until(() => child.prompts().length === 3);
  child.respond(child.prompts()[1].id, { stopReason: 'end_turn' });
  assert.deepEqual(await s2, { outcome: 'injected' });
  assert.equal(await settledState(result), 'pending');
  child.respond(child.prompts()[2].id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('a steer racing the turn end becomes the next agy turn inside the same user turn', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  // The first prompt's natural end is already on its way when the steer is written.
  child.respond(first.id, { stopReason: 'end_turn' });
  const steer = h.b.steerSession({ sessionId: h.sessionId, prompt: text('late but running') });
  const outcome = await steer;
  if (outcome.outcome === 'promptRequired') {
    // The turn had already ended: the runtime sends it as a normal prompt; nothing was sent.
    assert.equal(child.prompts().length, 1);
    assert.deepEqual(await result, { stopReason: 'end_turn' });
    return;
  }
  assert.deepEqual(outcome, { outcome: 'injected' });
  assert.equal(child.prompts().length, 2);
  assert.equal(await settledState(result), 'pending');
  child.respond(child.prompts()[1].id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('a steer resolved after the turn ended is never sent: promptRequired', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
  assert.deepEqual(await h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') }), {
    outcome: 'promptRequired',
  });
  assert.equal(child.prompts().length, 1);
});

test('agy refusing the steered prompt queues it and never cancels the running turn', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  const steer = h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') });
  await until(() => child.prompts().length === 2);
  child.fail(child.prompts()[1].id, 'busy');
  assert.deepEqual(await steer, { outcome: 'queueRequired' });
  assert.ok(!child.notifications.some((n) => n.method === 'session/cancel'));
  assert.equal(await settledState(result), 'pending');
  child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
  child.respond(first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('no acceptance signal in time: the message stays with agy as injected, never duplicated', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  assert.deepEqual(await h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') }), {
    outcome: 'injected',
  });
  assert.equal(child.prompts().length, 2);
  child.respond(first.id, { stopReason: 'end_turn' });
  child.respond(child.prompts()[1].id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('an error of the last prompt fails the turn', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  child.fail(first.id, 'quota exhausted');
  await assert.rejects(result, /quota exhausted/);
});

test('agy acp dying mid-turn rejects the turn instead of leaving it running', async (t) => {
  const h = await harness(t);
  const { result, child } = await startTurn(h);
  child.closed = true;
  child.emit('close', 1);
  await assert.rejects(result, /Antigravity/);
});

const BG_START = (task) =>
  `Created At: 2026-11-25T20:43:28+03:00\nTool is running as a background task with task id: ${NATIVE}/${task}\nTask Description: sleep 25 && echo bg-finished\nTask logs are available at: file:///nowhere/${task}.log`;
async function backgroundTurn(t, extra = {}) {
  const h = await harness(t, { mode: 'auto', extra });
  const logs = join(h.brainDirectory, NATIVE, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  const transcript = join(logs, 'transcript.jsonl');
  await writeFile(transcript, '');
  const turn = await startTurn(h);
  turn.child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_bg',
    name: 'run_command',
    args: { CommandLine: 'sleep 25 && echo bg-finished', WaitMsBeforeAsync: 500 },
    rawInput: { CommandLine: 'sleep 25 && echo bg-finished', WaitMsBeforeAsync: 500 },
    status: 'in_progress',
    kind: 'execute',
  });
  await until(() => h.updates.some((u) => u.toolCallId === 'agy-acp-1'));
  await appendFile(
    transcript,
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: '"sleep 25 \\u0026\\u0026 echo bg-finished"' },
        },
      ],
    }) +
      '\n' +
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: BG_START('task-2'),
      }) +
      '\n'
  );
  await until(
    () => h.updates.some((u) => u._meta?.orkestra?.backgroundTask?.state === 'running'),
    'background row'
  );
  return { h, ...turn };
}
const bgRows = (h) => h.updates.filter((u) => u._meta?.orkestra?.backgroundTask);

test('a command agy moves to the background becomes a background row and closes when it ends', async (t) => {
  const { h, result, child, first } = await backgroundTurn(t);
  const running = bgRows(h).at(-1);
  assert.equal(running.toolCallId, 'agy-acp-1');
  assert.equal(running.title, 'sleep 25 && echo bg-finished');
  // The agent's reply while the task runs streams live (no transcript mirroring on acp).
  child.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'started' },
  });
  child.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_bg',
    status: 'completed',
    rawOutput: {
      output: 'Command exited with code 0.\n\nCommand output:\nbg-finished\n',
      exit_code: 0,
    },
  });
  await until(() => bgRows(h).at(-1)._meta.orkestra.backgroundTask.state === 'completed');
  // agy may repeat the end: the closed row keeps its final state.
  child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg', status: 'failed' });
  child.respond(first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
  const rows = h.updates.filter((u) => u.toolCallId === 'agy-acp-1');
  assert.equal(rows.at(-1)._meta.orkestra.backgroundTask.state, 'completed');
  assert.equal(h.updates.filter((u) => u.content?.text === 'started').length, 1);
});

test('a steer while the turn waits on a background task joins it; the task keeps running', async (t) => {
  const { h, result, child, first } = await backgroundTurn(t);
  const steer = h.b.steerSession({ sessionId: h.sessionId, prompt: text('2+2?') });
  await until(() => child.prompts().length === 2);
  child.respond(first.id, { stopReason: 'end_turn' }); // run11: 1 ms after the second prompt
  assert.deepEqual(await steer, { outcome: 'injected' });
  assert.equal(bgRows(h).at(-1)._meta.orkestra.backgroundTask.state, 'running');
  assert.ok(!child.notifications.some((n) => n.method === 'session/cancel'));
  child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg', status: 'completed' });
  child.respond(child.prompts()[1].id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('Stop cancels through agy, ends the background command and marks the row stopped', async (t) => {
  const signals = [];
  let alive = true;
  const table = () =>
    alive
      ? [
          { pid: 7000, ppid: 1, pgid: 7000, args: '/mock/agy acp --dangerously-skip-permissions' },
          { pid: 9100, ppid: 7000, pgid: 9100, args: 'zsh -c sleep 25 && echo bg-finished' },
          { pid: 9101, ppid: 9100, pgid: 9100, args: 'sleep 25' },
        ]
      : [{ pid: 7000, ppid: 1, pgid: 7000, args: '/mock/agy acp --dangerously-skip-permissions' }];
  const { h, result, child, first } = await backgroundTurn(t, {
    platform: 'darwin',
    taskKillGraceMs: 10,
    listProcesses: async () => table(),
    signalProcess: (pid, signal) => signals.push([pid, signal]),
  });
  await h.b.cancel({ sessionId: h.sessionId });
  assert.ok(
    child.notifications.some((n) => n.method === 'session/cancel' && n.params.sessionId === NATIVE)
  );
  // agy fails the row and answers cancelled; the turn's end marks it stopped with the real outcome.
  child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg', status: 'failed' });
  child.respond(first.id, { stopReason: 'cancelled' });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
  // run20: agy repeats the failed end after answering; the stopped row keeps its state.
  child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_bg', status: 'failed' });
  await tick(20);
  assert.equal(
    h.updates.filter((u) => u.toolCallId === 'agy-acp-1').at(-1)._meta?.orkestra?.backgroundTask
      ?.state,
    'stopped'
  );
  const last = bgRows(h).at(-1);
  assert.equal(last._meta.orkestra.backgroundTask.state, 'stopped');
  assert.match(last.content[0].content.text, /komutu da sonlandırıldı/);
  // agy did not end it (still in the table): the adapter ends exactly the owned tree.
  await until(() => signals.length > 0, 'safety-net signals');
  assert.deepEqual(
    signals.map(([pid]) => pid).sort((a, b) => a - b),
    [-9100, 9100, 9101]
  );
  alive = false;
});

test('Stop: agy not answering the cancel gets its process killed after the grace period', async (t) => {
  const h = await harness(t);
  const { result, child } = await startTurn(h);
  await h.b.cancel({ sessionId: h.sessionId });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
  assert.ok(child.signals.includes('SIGKILL'));
});

test('closing a conversation is not a Stop: agy keeps the work, the process ends after it', async (t) => {
  const { h, result, child, first } = await backgroundTurn(t);
  await h.b.closeSession({ sessionId: h.sessionId });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
  assert.ok(!child.notifications.some((n) => n.method === 'session/cancel'));
  assert.ok(!child.requests.some((r) => r.method === 'session/close'));
  assert.equal(child.closed, false, 'agy acp keeps running its turn');
  assert.match(bgRows(h).at(-1).content[0].content.text, /sürdürüyor/);
  const before = h.updates.length;
  child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  child.respond(first.id, { stopReason: 'end_turn' });
  await until(() => child.closed, 'stdin closed after the work ended');
  assert.equal(h.updates.length, before, 'nothing is shown for a closed conversation');
});

test('resume after a restart attaches with session/resume and replays history only once', async (t) => {
  const h = await harness(t);
  h.b.session(h.sessionId).nativeId = NATIVE;
  await h.b.save(h.sessionId, h.b.session(h.sessionId));
  const logs = join(h.brainDirectory, NATIVE, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await writeFile(
    join(logs, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nold\n</USER_REQUEST>',
    }) + '\n'
  );
  // A fresh adapter process (the app restarted).
  const fake = fakeAgy();
  const updates = [];
  const b2 = new AntigravityBridge({
    cli: '/mock/agy',
    directory: h.directory,
    brainDirectory: h.brainDirectory,
    transport: 'acp',
    notify: (x) => updates.push(x.params.update),
    exec: (_c, _a, _o, cb) => cb(null, 'model-1\tModel One\n'),
    spawnProcess: fake.spawnProcess,
  });
  t.after(() => b2.shutdown());
  await b2.loadSession({ sessionId: h.sessionId, cwd: h.directory });
  assert.deepEqual(
    updates.map((u) => u.content?.text),
    ['old']
  );
  const result = b2.prompt({ sessionId: h.sessionId, prompt: text('new') });
  await until(() => fake.acp()[0]?.prompts().length === 1);
  const child = fake.acp()[0];
  const attach = child.requests.find((r) => r.method === 'session/resume');
  assert.equal(attach.params.sessionId, NATIVE);
  assert.ok(!child.requests.some((r) => r.method === 'session/new'));
  child.respond(child.prompts()[0].id, { stopReason: 'end_turn' });
  await result;
  assert.equal(updates.filter((u) => u.sessionUpdate === 'user_message_chunk').length, 1);
});

test('without session/resume the conversation is loaded and its replay is dropped', async (t) => {
  const fake = fakeAgy({
    resume: false,
    onRequest: (child, m) => {
      if (m.method !== 'session/load') return undefined;
      child.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } });
      child.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old reply' },
      });
      setImmediate(() => child.respond(m.id, {}));
      return 'handled';
    },
  });
  const h = await harness(t, { fake });
  h.b.session(h.sessionId).nativeId = NATIVE;
  const { result, child, first } = await startTurn(h);
  assert.ok(child.requests.some((r) => r.method === 'session/load'));
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
  assert.deepEqual(h.updates, []);
});

test('a conversation agy acp cannot attach falls back to stream-json for the turn', async (t) => {
  const fake = fakeAgy({
    onRequest: (child, m) => {
      if (m.method === 'session/set_model') {
        child.fail(m.id, 'unknown model');
        return 'handled';
      }
      return undefined;
    },
  });
  const h = await harness(t, { fake });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  await until(() => fake.spawns.some((c) => c.args.includes('--input-format')));
  assert.ok(fake.acp()[0].signals.includes('SIGTERM'));
  await h.b.cancel({ sessionId: h.sessionId });
  await result;
});

test('default mode: tools needing approval are refused and reported; app MCP tools are approved', async (t) => {
  const h = await harness(t);
  await h.b.loadSession({
    sessionId: h.sessionId,
    cwd: h.directory,
    mcpServers: [{ name: 'orkestra-subagents', command: 'node', args: ['x'] }],
  });
  const { result, child, first } = await startTurn(h);
  const options = [
    { optionId: 'yes', kind: 'allow_once', name: 'Yes' },
    { optionId: 'no', kind: 'reject_once', name: 'No' },
  ];
  child.ask(901, 'session/request_permission', {
    sessionId: NATIVE,
    toolCall: { toolCallId: 'c1', name: 'write_file', title: 'File hello.txt' },
    options,
  });
  child.ask(902, 'session/request_permission', {
    sessionId: NATIVE,
    toolCall: {
      toolCallId: 'c2',
      name: 'call_mcp_tool',
      rawInput: { ServerName: 'orkestra-subagents', ToolName: 'run_subagent' },
    },
    options,
  });
  await until(() => child.clientResponses.length === 2);
  const byId = Object.fromEntries(
    child.clientResponses.map((r) => [r.id, r.result.outcome.optionId])
  );
  assert.deepEqual(byId, { 901: 'no', 902: 'yes' });
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
  assert.match(h.updates.at(-1).content.text, /write_file/);
});

test('permission helpers', () => {
  const servers = { 'orkestra-widgets': { command: 'n', args: [], disabled: false } };
  assert.ok(
    isBuiltinMcpPermission({ toolCall: { name: 'orkestra-widgets/show_widget' } }, servers)
  );
  assert.ok(!isBuiltinMcpPermission({ toolCall: { name: 'other/show_widget' } }, servers));
  assert.ok(!isBuiltinMcpPermission({ toolCall: { name: 'run_command' } }, servers));
  assert.ok(
    !isBuiltinMcpPermission(
      { toolCall: { name: 'orkestra-widgets/show_widget' } },
      { 'orkestra-widgets': { disabled: true } }
    )
  );
  assert.deepEqual(permissionResponse({ options: [] }, { allow: true }), {
    outcome: { outcome: 'cancelled' },
  });
});

test('ACP tool updates become stream-json steps (name, args and output are carried over)', () => {
  const first = acpToolStep({
    toolCallId: 'c',
    name: 'swarm',
    rawInput: { action: 'add', name: 'w' },
    status: 'in_progress',
  });
  assert.equal(first.step.state, 'ACTIVE');
  assert.equal(first.step.tool_name, 'swarm');
  const end = acpToolStep(
    {
      toolCallId: 'c',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
    },
    first
  );
  assert.equal(end.step.state, 'DONE');
  assert.equal(end.step.tool_name, 'swarm');
  assert.deepEqual(end.step.tool_info.parameters, { action: 'add', name: 'w' });
  assert.equal(end.step.tool_info.output, 'out');
  assert.ok(acpToolStep({ status: 'failed' }, first).step.tool_info.error);
});

test('image attachments reach agy acp as file paths in the prompt text', async (t) => {
  const h = await harness(t);
  const result = h.b.prompt({
    sessionId: h.sessionId,
    prompt: [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
    ],
  });
  await until(() => h.fake.acp()[0]?.prompts().length === 1);
  const child = h.fake.acp()[0];
  const sent = child.prompts()[0].params.prompt[0].text;
  assert.match(sent, /^look\n/);
  assert.match(sent, /Kullanıcı görsel ekledi: .*attachments/);
  child.respond(child.prompts()[0].id, { stopReason: 'end_turn' });
  await result;
});

test('changing the model restarts agy acp; an unchanged session reuses it', async (t) => {
  const h = await harness(t);
  const one = await startTurn(h);
  one.child.respond(one.first.id, { stopReason: 'end_turn' });
  await one.result;
  const again = h.b.prompt({ sessionId: h.sessionId, prompt: text('again') });
  await until(() => one.child.prompts().length === 2);
  one.child.respond(one.child.prompts()[1].id, { stopReason: 'end_turn' });
  await again;
  assert.equal(h.fake.acp().length, 1);
  await h.b.setSessionConfigOption({ sessionId: h.sessionId, configId: 'mode', value: 'auto' });
  assert.ok(one.child.closed);
  const two = await startTurn(h);
  assert.notEqual(two.child, one.child);
  assert.equal(
    two.child.requests.find((r) => r.method === 'session/resume').params.sessionId,
    NATIVE
  );
  two.child.respond(two.first.id, { stopReason: 'end_turn' });
  await two.result;
});

test('swarm members and orkestra-subagents runs become sub-agent rows on acp too', async (t) => {
  const h = await harness(t);
  const { result, child, first } = await startTurn(h);
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_swarm',
    name: 'swarm',
    rawInput: { action: 'add', name: 'researcher', brief: 'find the bug' },
    status: 'in_progress',
  });
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_sub',
    name: 'call_mcp_tool',
    rawInput: {
      ServerName: 'orkestra-subagents',
      ToolName: 'run_subagent',
      Arguments: JSON.stringify({
        model: 'claude-opus-5-5-high',
        prompt: 'review it',
        role: 'Reviewer',
      }),
    },
    status: 'in_progress',
  });
  await until(() => h.updates.length >= 2);
  const swarm = h.updates.find((u) => u.toolCallId === 'agy-acp-1');
  assert.equal(swarm._meta.orkestra.toolKind, 'subagent');
  assert.equal(swarm._meta.antigravity.kind, 'subagent');
  assert.equal(swarm.rawInput.description, 'find the bug');
  const sub = h.updates.find((u) => u.toolCallId === 'agy-acp-2');
  assert.equal(sub._meta.antigravity.kind, 'subagent');
  assert.equal(sub.title, 'Reviewer');
  assert.equal(sub._meta.antigravity.prompt, 'review it');
  await h.b.cancel({ sessionId: h.sessionId });
  child.respond(first.id, { stopReason: 'cancelled' });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
});

test('an orchestrator model without Orkestra roles also stays on stream-json', async (t) => {
  const fake = fakeAgy();
  const h = await harness(t, { fake });
  await h.b.setSessionConfigOption({
    sessionId: h.sessionId,
    configId: 'model',
    value: 'gemini-pro-orchestrator',
  });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  assert.equal(fake.acp().length, 0);
  assert.ok(fake.spawns[0].args.includes('--input-format'));
  await h.b.cancel({ sessionId: h.sessionId });
  await result;
  // A standard model in the same session goes back to agy acp.
  await h.b.setSessionConfigOption({ sessionId: h.sessionId, configId: 'model', value: 'model-1' });
  const next = await startTurn(h);
  next.child.respond(next.first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await next.result, { stopReason: 'end_turn' });
});

test('queue reasons: stream-json sessions say why, a starting acp turn says connecting', async (t) => {
  const plain = await harness(t, { transport: 'stream-json' });
  const running = plain.b.prompt({ sessionId: plain.sessionId, prompt: text('hi') });
  assert.deepEqual(await plain.b.steerSession({ sessionId: plain.sessionId, prompt: text('x') }), {
    outcome: 'queueRequired',
    queueReason: 'antigravity-stream-json',
  });
  await plain.b.cancel({ sessionId: plain.sessionId });
  await running;

  let releaseInit;
  const fake = fakeAgy({
    onRequest: (child, m) => {
      if (m.method !== 'initialize') return undefined;
      releaseInit = () =>
        child.respond(m.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } });
      return 'handled';
    },
  });
  const h = await harness(t, { fake });
  const result = h.b.prompt({ sessionId: h.sessionId, prompt: text('hi') });
  await until(() => releaseInit, 'initialize');
  assert.deepEqual(await h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') }), {
    outcome: 'promptRequired',
    queueReason: 'connecting',
  });
  releaseInit();
  await until(() => fake.acp()[0].prompts().length === 1);
  const child = fake.acp()[0];
  child.respond(child.prompts()[0].id, { stopReason: 'end_turn' });
  await result;
  // An agy refusal of a steered prompt gives no reason of its own.
  const again = h.b.prompt({ sessionId: h.sessionId, prompt: text('again') });
  await until(() => child.prompts().length === 2);
  const steer = h.b.steerSession({ sessionId: h.sessionId, prompt: text('x') });
  await until(() => child.prompts().length === 3);
  child.fail(child.prompts()[2].id, 'busy');
  assert.deepEqual(await steer, { outcome: 'queueRequired' });
  child.respond(child.prompts()[1].id, { stopReason: 'end_turn' });
  await again;
});

// --- agy'nin yerleşik alt ajanları ve run_subagent (yakalamalar: agy-alt-ajan-capture r02-r11) ---
const SUB_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SUB_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SUB_C = 'cccccccc-3333-4333-8333-333333333333';
const generated = (h, id, ...parts) => join(h.brainDirectory, id, '.system_generated', ...parts);
async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
// agy bir alt ajan yarattığında yazdıkları: üstte alt ajan kaydı, altta ilk (görev) mesajı.
async function spawnSubagent(h, id, { acpToolCallId, prompt, role }) {
  await writeJson(generated(h, NATIVE, 'subagents', `${id}.json`), {
    conversationId: id,
    subagentDescriptor: { typeName: 'self', role },
    state: 'SUBAGENT_STATE_ALIVE',
  });
  await writeJson(generated(h, id, 'messages', `msg-${id}.json`), {
    id: `msg-${id}`,
    recipient: id,
    sender: NATIVE,
    content: prompt,
    sourceMetadata: {
      tool: {
        conversationId: NATIVE,
        toolCall: {
          id: acpToolCallId,
          name: 'invoke_subagent',
          argumentsJson: JSON.stringify({ Prompt: prompt, Role: role, TypeName: 'self' }),
        },
      },
    },
  });
  await writeJson(generated(h, id, 'messages', 'read.json'), {});
}
const at = (seconds) => new Date(Date.UTC(2026, 10, 25, 19, 10, seconds)).toISOString();
const subRows = {
  start: (prompt) => ({
    step_index: 0,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: at(52),
    content: `<SYSTEM_MESSAGE>\n[Message] sender=${NATIVE} content=${prompt}\n</SYSTEM_MESSAGE>`,
  }),
  command: {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: at(53),
    model: 'gemini-3.8-flash-low',
    tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 8 && echo beta"' } }],
  },
  answer: (text) => ({
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: at(56),
    model: 'gemini-3.8-flash-low',
    content: text,
  }),
};
async function writeTranscript(path, rows) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}
const subTranscript = (h, id) => generated(h, id, 'logs', 'transcript.jsonl');
function invoke(child, toolCallId, { prompt, role }, status = 'in_progress') {
  const args = { Prompt: prompt, Role: role, TypeName: 'self' };
  child.update({
    sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
    toolCallId,
    name: 'invoke_subagent',
    args,
    rawInput: args,
    status,
    kind: 'other',
    title: 'Run invoke_subagent',
  });
}
const rowUpdates = (h, rowId) => h.updates.filter((u) => u.toolCallId === rowId);
const cardOf = (h, rowId) => rowUpdates(h, rowId).at(-1)?._meta?.antigravity;
const subHarness = (t, options = {}) =>
  harness(t, {
    ...options,
    extra: { subagentPollMs: 10, subagentResolveMs: 2000, ...options.extra },
  });

test('agy sub-agent helpers read the captured shapes', () => {
  assert.equal(subagentOfToolCallId(`${SUB_A}:call_1`), SUB_A);
  assert.equal(subagentOfToolCallId('call_1'), undefined);
  const created = parseCreatedSubagent(
    'Created At: x\nCreated the following subagent:\n{\n  "conversationId":  "' +
      SUB_A +
      '",\n  "logAbsoluteUri":  "file:///b/' +
      SUB_A +
      '/.system_generated/logs/transcript.jsonl"\n}\nThe subagent will send you a message.'
  );
  assert.equal(created.conversationId, SUB_A);
  assert.equal(parseCreatedSubagent('permission denied'), undefined);
  const one = {
    sender: 'system',
    content: `Subagent "${SUB_A}" has been explicitly canceled by the user and will be idle.`,
  };
  assert.ok(isSubagentCancelledMessage(one, SUB_A));
  assert.ok(!isSubagentCancelledMessage(one, SUB_B));
  const all = {
    sender: 'system',
    timestamp: '2026-11-25T19:23:38.082311Z',
    content:
      '[Notice] All your subagents and background tasks have been stopped due to user force cancellation.',
  };
  assert.ok(isSubagentCancelledMessage(all, SUB_B, Date.parse('2026-11-25T19:23:28Z')));
  assert.ok(!isSubagentCancelledMessage(all, SUB_B, Date.parse('2026-11-25T19:30:00Z')));
  assert.ok(!isSubagentCancelledMessage({ sender: SUB_A, content: 'alpha' }, SUB_A));
  const spawn = {
    content: 'task',
    sourceMetadata: { tool: { toolCall: { id: 'c1', name: 'invoke_subagent' } } },
  };
  assert.ok(isSpawnMessageOf(spawn, { acpToolCallId: 'c1' }));
  assert.ok(isSpawnMessageOf(spawn, { acpToolCallId: 'other', prompt: 'task' }));
  assert.ok(!isSpawnMessageOf(spawn, { acpToolCallId: 'other', prompt: 'else' }));
  assert.equal(subagentToolTitle('manage_subagents', { Action: 'list' }), 'Alt ajanlar listelendi');
  assert.equal(subagentToolTitle('send_message', {}), 'Alt ajana mesaj gönderildi');
  assert.equal(
    subagentToolTitle('schedule', { DurationSeconds: 15, Prompt: 'Waiting for Beta' }),
    'Bekleniyor (15 sn): Waiting for Beta'
  );
  assert.equal(
    subagentToolTitle('call_mcp_tool', {
      ServerName: 'orkestra-subagents',
      ToolName: 'list_subagent_models',
    }),
    'Alt ajan modelleri listelendi'
  );
  assert.equal(subagentToolTitle('run_command', {}), undefined);
});

test('acp: a built-in sub-agent is a card from the start, follows its conversation and answers', async (t) => {
  const h = await subHarness(t);
  const { result, child, first } = await startTurn(h);
  const task = { prompt: 'Reply with the single word alpha.', role: 'Alpha' };
  invoke(child, 'call_inv_a', task);
  await until(() => rowUpdates(h, 'agy-acp-1').length >= 1, 'card');
  const start = h.updates.find((u) => u.toolCallId === 'agy-acp-1');
  assert.equal(start.sessionUpdate, 'tool_call');
  assert.equal(start.title, 'Alpha');
  assert.deepEqual(
    { ...start._meta.antigravity },
    {
      kind: 'subagent',
      toolCallId: 'agy-acp-1',
      title: 'Alpha',
      provider: 'antigravity',
      role: 'self',
      prompt: task.prompt,
      background: true,
      detached: true,
      status: 'in_progress',
    }
  );
  // "Started" is no end: the card keeps running.
  invoke(child, 'call_inv_a', task, 'completed');
  await tick(30);
  assert.ok(rowUpdates(h, 'agy-acp-1').every((u) => u.status === 'in_progress'));
  assert.ok(!h.updates.some((u) => u.title === 'invoke_subagent'), 'no raw tool row');
  await spawnSubagent(h, SUB_A, { acpToolCallId: 'call_inv_a', ...task });
  await writeTranscript(subTranscript(h, SUB_A), [subRows.start(task.prompt), subRows.command]);
  await until(() => cardOf(h, 'agy-acp-1')?.model === 'Gemini 3.8 Flash', 'live steps');
  const running = cardOf(h, 'agy-acp-1');
  assert.equal(running.kind, 'subagent_update');
  assert.equal(running.agentId, SUB_A);
  assert.equal(running.outputFile, subTranscript(h, SUB_A));
  assert.equal(running.status, 'in_progress');
  assert.equal(running.effort, 'low');
  assert.equal(running.activities[0].title, 'Komut çalıştırılıyor');
  await writeTranscript(subTranscript(h, SUB_A), [
    subRows.start(task.prompt),
    subRows.command,
    subRows.answer('alpha'),
  ]);
  await until(() => cardOf(h, 'agy-acp-1')?.status === 'completed', 'answer');
  assert.equal(cardOf(h, 'agy-acp-1').summary, 'alpha');
  assert.equal(rowUpdates(h, 'agy-acp-1').at(-1).status, 'completed');
  child.respond(first.id, { stopReason: 'end_turn' });
  assert.deepEqual(await result, { stopReason: 'end_turn' });
});

test('acp: parallel built-in sub-agents each get their own card and conversation', async (t) => {
  const h = await subHarness(t);
  const { result, child, first } = await startTurn(h);
  const alpha = { prompt: 'Reply alpha.', role: 'Alpha' };
  const beta = { prompt: 'Reply beta.', role: 'Beta' };
  invoke(child, 'call_inv_a', alpha);
  invoke(child, 'call_inv_a', alpha, 'completed');
  invoke(child, 'call_inv_b', beta);
  invoke(child, 'call_inv_b', beta, 'completed');
  // agy lists them in any order; the spawn message names the ACP call.
  await spawnSubagent(h, SUB_B, { acpToolCallId: 'call_inv_b', ...beta });
  await spawnSubagent(h, SUB_A, { acpToolCallId: 'call_inv_a', ...alpha });
  await until(() => cardOf(h, 'agy-acp-1')?.agentId && cardOf(h, 'agy-acp-2')?.agentId, 'both');
  assert.equal(cardOf(h, 'agy-acp-1').agentId, SUB_A);
  assert.equal(cardOf(h, 'agy-acp-2').agentId, SUB_B);
  assert.equal(rowUpdates(h, 'agy-acp-2')[0].title, 'Beta');
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
});

test('acp: a sub-agent tool refused by the mode is no row; its card ends stopped and says why', async (t) => {
  const h = await subHarness(t);
  const { result, child, first } = await startTurn(h);
  const beta = { prompt: 'Run `sleep 8 && echo beta`.', role: 'Beta' };
  invoke(child, 'call_inv_b', beta);
  invoke(child, 'call_inv_b', beta, 'completed');
  await spawnSubagent(h, SUB_B, { acpToolCallId: 'call_inv_b', ...beta });
  await writeTranscript(subTranscript(h, SUB_B), [subRows.start(beta.prompt), subRows.command]);
  await until(() => cardOf(h, 'agy-acp-1')?.agentId === SUB_B, 'matched');
  const own = `${SUB_B}:call_42`;
  const call = {
    sessionUpdate: 'tool_call',
    toolCallId: own,
    name: 'run_command',
    rawInput: { CommandLine: 'sleep 8 && echo beta' },
    status: 'pending',
    kind: 'execute',
    title: 'sleep 8 && echo beta',
  };
  child.update(call);
  child.ask('1', 'session/request_permission', {
    sessionId: NATIVE,
    toolCall: call,
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    ],
  });
  await until(() => child.clientResponses.length === 1, 'permission answer');
  assert.equal(child.clientResponses[0].result.outcome.optionId, 'deny');
  child.update({ ...call, sessionUpdate: 'tool_call_update', status: 'failed' });
  await writeJson(generated(h, NATIVE, 'messages', 'cancel.json'), {
    sender: 'system',
    hideFromUser: true,
    content: `Subagent "${SUB_B}" has been explicitly canceled by the user and will be idle until you send a message to it directly.`,
  });
  await until(() => cardOf(h, 'agy-acp-1')?.status === 'failed', 'stopped');
  const card = cardOf(h, 'agy-acp-1');
  assert.equal(card.interrupted, true);
  assert.match(card.summary, /run_command/);
  assert.ok(!h.updates.some((u) => u.toolCallId?.includes(SUB_B)), 'no row for its own call');
  assert.ok(!h.updates.some((u) => u.title === 'sleep 8 && echo beta'));
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
});

test('acp: Stop of the turn ends a running built-in sub-agent as stopped (agy notice)', async (t) => {
  const h = await subHarness(t);
  const { result, child, first } = await startTurn(h);
  const gamma = { prompt: 'Run `sleep 25`.', role: 'Gamma' };
  invoke(child, 'call_inv_c', gamma);
  invoke(child, 'call_inv_c', gamma, 'completed');
  await spawnSubagent(h, SUB_C, { acpToolCallId: 'call_inv_c', ...gamma });
  await writeTranscript(subTranscript(h, SUB_C), [subRows.start(gamma.prompt), subRows.command]);
  await until(() => cardOf(h, 'agy-acp-1')?.model, 'running');
  await h.b.cancel({ sessionId: h.sessionId });
  child.respond(first.id, { stopReason: 'cancelled' });
  assert.deepEqual(await result, { stopReason: 'cancelled' });
  await writeJson(generated(h, NATIVE, 'messages', 'notice.json'), {
    sender: 'system',
    timestamp: new Date(Date.UTC(2026, 10, 25, 19, 11, 30)).toISOString(),
    content:
      '[Notice] All your subagents and background tasks have been stopped due to user force cancellation.',
  });
  await until(() => cardOf(h, 'agy-acp-1')?.status === 'failed', 'stopped');
  assert.equal(cardOf(h, 'agy-acp-1').interrupted, true);
});

test('acp: agy ending while a built-in sub-agent runs leaves its card "outcome unknown"', async (t) => {
  const h = await subHarness(t);
  const { result, child } = await startTurn(h);
  const gamma = { prompt: 'Run `sleep 25`.', role: 'Gamma' };
  invoke(child, 'call_inv_c', gamma);
  invoke(child, 'call_inv_c', gamma, 'completed');
  await spawnSubagent(h, SUB_C, { acpToolCallId: 'call_inv_c', ...gamma });
  await writeTranscript(subTranscript(h, SUB_C), [subRows.start(gamma.prompt), subRows.command]);
  await until(() => cardOf(h, 'agy-acp-1')?.model, 'running');
  child.kill('SIGKILL');
  await assert.rejects(result);
  const last = rowUpdates(h, 'agy-acp-1').at(-1);
  assert.equal(last.status, 'completed');
  assert.equal(last._meta.antigravity.statusUnknown, true);
  assert.equal(last._meta.antigravity.kind, 'subagent_update');
});

test('acp: sub-agent tool rows have readable Turkish titles', async (t) => {
  const h = await subHarness(t);
  const { result, child, first } = await startTurn(h);
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_m',
    name: 'manage_subagents',
    rawInput: { Action: 'list' },
    status: 'in_progress',
  });
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_s',
    name: 'send_message',
    rawInput: { Message: 'more', Recipient: SUB_A },
    status: 'in_progress',
  });
  child.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_l',
    name: 'call_mcp_tool',
    rawInput: { ServerName: 'orkestra-subagents', ToolName: 'list_subagent_models', Arguments: {} },
    status: 'in_progress',
  });
  await until(() => h.updates.length >= 3);
  assert.deepEqual(
    h.updates.map((u) => u.title),
    ['Alt ajanlar listelendi', 'Alt ajana mesaj gönderildi', 'Alt ajan modelleri listelendi']
  );
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
});

// Geçmiş: üst konuşmanın transcript'i (yakalama r04/r06/r08 biçimi).
async function writeParentHistory(h) {
  const q = (value) => JSON.stringify(value);
  const call = (prompt, role) => ({
    name: 'invoke_subagent',
    args: { Prompt: q(prompt), Role: q(role), TypeName: q('self') },
  });
  const created = (id) =>
    `Created At: x\nCreated the following subagent:\n{\n  "conversationId":  "${id}",\n  "logAbsoluteUri":  "file:///x/${id}/.system_generated/logs/transcript.jsonl"\n}\nThe subagent will send you a message when it has completed its task.`;
  await writeTranscript(generated(h, NATIVE, 'logs', 'transcript.jsonl'), [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\nstart them\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        call('Reply alpha.', 'Alpha'),
        call('Run sleep.', 'Beta'),
        call('Run long.', 'Gamma'),
      ],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: created(SUB_A) },
    { step_index: 3, type: 'GENERIC', status: 'DONE', content: created(SUB_B) },
    { step_index: 4, type: 'GENERIC', status: 'DONE', content: created(SUB_C) },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [call('Never made.', 'Delta')],
    },
  ]);
  await writeTranscript(subTranscript(h, SUB_A), [
    subRows.start('Reply alpha.'),
    subRows.answer('alpha'),
  ]);
  await writeTranscript(subTranscript(h, SUB_B), [subRows.start('Run sleep.'), subRows.command]);
  await writeTranscript(subTranscript(h, SUB_C), [subRows.start('Run long.'), subRows.command]);
  await writeJson(generated(h, NATIVE, 'messages', 'cancel.json'), {
    sender: 'system',
    content: `Subagent "${SUB_B}" has been explicitly canceled by the user.`,
  });
}

test('replay: built-in sub-agent cards come back with their real end', async (t) => {
  const h = await subHarness(t);
  const one = await startTurn(h);
  one.child.respond(one.first.id, { stopReason: 'end_turn' });
  await one.result;
  await h.b.terminateProcess(h.sessionId);
  await writeParentHistory(h);
  h.updates.length = 0;
  await h.b.loadSession({ sessionId: h.sessionId, cwd: h.directory });
  const final = (rowId) => rowUpdates(h, rowId).at(-1)._meta.antigravity;
  assert.equal(rowUpdates(h, 'agy-replay-1-0')[0]._meta.antigravity.kind, 'subagent');
  assert.equal(rowUpdates(h, 'agy-replay-1-0')[0].title, 'Alpha');
  assert.deepEqual(
    ['agy-replay-1-0', 'agy-replay-1-1', 'agy-replay-1-2', 'agy-replay-5-0'].map((id) => {
      const m = final(id);
      return [m.status, m.agentId ?? null, Boolean(m.interrupted), Boolean(m.statusUnknown)];
    }),
    [
      ['completed', SUB_A, false, false],
      ['failed', SUB_B, true, false],
      // Nobody runs it any more and nothing says how it ended.
      ['completed', SUB_C, false, true],
      // agy stopped before it was even created.
      ['completed', null, false, true],
    ]
  );
  assert.equal(final('agy-replay-1-0').summary, 'alpha');
  assert.ok(!h.updates.some((u) => u.title === 'invoke_subagent'));
});

test('replay: an orchestrator conversation keeps its invoke_subagent rows as before', async (t) => {
  const h = await subHarness(t);
  await writeParentHistory(h);
  const s = h.b.session(h.sessionId);
  s.nativeId = NATIVE;
  s.model = 'gemini-pro-orchestrator';
  await h.b.save(h.sessionId, s);
  await h.b.loadSession({ sessionId: h.sessionId, cwd: h.directory });
  const rows = h.updates.filter((u) => u.toolCallId?.startsWith('agy-replay-1-'));
  assert.deepEqual(
    rows.map((u) => [u.title, u.status, u._meta?.antigravity?.kind ?? null]),
    [
      ['invoke_subagent', 'completed', null],
      ['invoke_subagent', 'completed', null],
      ['invoke_subagent', 'completed', null],
    ]
  );
});

test('acp: a run_subagent run stopped from its card ends stopped, not failed', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'orkestra-agy-runs-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const h = await subHarness(t, { extra: { subagentsStateDir: state } });
  await h.b.loadSession({
    sessionId: h.sessionId,
    cwd: h.directory,
    mcpServers: [{ name: 'orkestra-subagents', command: 'node', args: ['x'] }],
  });
  const { result, child, first } = await startTurn(h);
  const RUN = 'eeeeeeee-5555-4555-8555-555555555555';
  const args = {
    provider: 'antigravity',
    model: 'gemini-3.8-flash-low',
    role: 'Uzun',
    prompt: 'sleep 40',
  };
  const call = {
    toolCallId: 'call_run',
    name: 'call_mcp_tool',
    rawInput: { ServerName: 'orkestra-subagents', ToolName: 'run_subagent', Arguments: args },
    kind: 'execute',
    title: 'MCP Tool run_subagent',
  };
  child.update({ ...call, sessionUpdate: 'tool_call', status: 'in_progress' });
  await until(() => cardOf(h, 'agy-acp-1'), 'card');
  assert.equal(rowUpdates(h, 'agy-acp-1')[0].title, 'Uzun');
  // The card's Stop (core cancelSubagentRun) rewrote the run's state file.
  const run = {
    runId: RUN,
    prompt: 'sleep 40',
    provider: 'antigravity',
    model: 'Gemini 3.8 Flash',
    startedAt: Date.now(),
    status: 'failed',
    cancelled: true,
    summary: 'Alt ajan kullanıcı tarafından durduruldu.',
  };
  await writeFile(join(state, `${RUN}.json`), JSON.stringify(run));
  await until(() => cardOf(h, 'agy-acp-1')?.interrupted === true, 'watcher');
  child.update({
    ...call,
    sessionUpdate: 'tool_call_update',
    status: 'completed',
    rawOutput: JSON.stringify({ ok: false, runId: RUN, error: run.summary }),
  });
  await until(
    () => rowUpdates(h, 'agy-acp-1').filter((u) => u.status === 'failed').length >= 3,
    'final'
  );
  const last = cardOf(h, 'agy-acp-1');
  assert.equal(last.status, 'failed');
  assert.equal(last.interrupted, true);
  assert.equal(last.agentId, RUN);
  child.respond(first.id, { stopReason: 'end_turn' });
  await result;
});

test('an orchestrator session stays on stream-json under the default (auto) transport', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-agy-orch-auto-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'agy');
  await writeFile(cli, 'binary');
  const fake = fakeAgy();
  const b = new AntigravityBridge({
    cli,
    directory,
    brainDirectory: join(directory, 'brain'),
    transport: 'auto',
    spawnProcess: fake.spawnProcess,
    exec: (_cmd, _args, _opts, cb) =>
      cb(null, 'model-1\tModel One\ngemini-pro-orchestrator\tOrch\n'),
  });
  t.after(() => b.shutdown());
  assert.equal(await b.probeAcp(), true, 'agy acp is available');
  const { sessionId } = await b.newSession({ cwd: directory });
  await b.setSessionConfigOption({
    sessionId,
    configId: 'model',
    value: 'gemini-pro-orchestrator',
  });
  const result = b.prompt({ sessionId, prompt: text('hi') });
  await until(() => fake.spawns.length === 2, 'turn process');
  const turnProcess = fake.spawns.at(-1);
  assert.ok(!turnProcess.args.includes('acp'));
  assert.ok(turnProcess.args.includes('--input-format'));
  await b.cancel({ sessionId });
  await result;
});
