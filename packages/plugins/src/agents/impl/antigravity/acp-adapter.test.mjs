import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AntigravityBridge, buildArgs, parseModels, promptText } from './acp-adapter.mjs';
test('model slugs are parsed, status chatter is ignored', () =>
  assert.deepEqual(parseModels('Fetching models...\nmodel-1\tModel One\n'), [
    { value: 'model-1', name: 'Model One' },
  ]));
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
async function setup(t, events) {
  const directory = await mkdtemp(join(tmpdir(), 'orkestra-acp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const updates = [],
    calls = [];
  let child;
  const b = new AntigravityBridge({
    cli: '/mock/agy',
    directory,
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
      child.stdin.on('finish', () =>
        setImmediate(() => {
          if (events) {
            for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
            child.stdout.end();
            setImmediate(() => child.emit('close', 0));
          }
        })
      );
      return child;
    },
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
