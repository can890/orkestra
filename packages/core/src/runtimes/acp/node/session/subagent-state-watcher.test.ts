import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isErr, isOk } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import { peek } from '@orkestra/wire/state';
import { createTestWire } from '@orkestra/wire/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpApiContract } from '#runtimes/acp/api';
import { FakeAcpAgent, makeAcpHarness, makeStartInput } from '#runtimes/acp/node/acp-test-support';
import { createAcpController } from '#runtimes/acp/node/api/controller';
import { materializeBuiltinSubagentsBridge } from '#runtimes/acp/node/runtime/builtin-subagents-mcp';
import { AcpRuntime } from '#runtimes/acp/node/runtime/runtime';
import { SessionCell } from './cell';
import {
  cancelSubagentRun,
  SubagentStateWatcher,
  type SubagentUpdateEvent,
} from './subagent-state-watcher';

const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const RUN_3 = '33333333-3333-4333-8333-333333333333';

const tempDirs: string[] = [];
const originalSubagentsEnv = process.env.ORKESTRA_SUBAGENTS_DIR;

afterEach(async () => {
  if (originalSubagentsEnv === undefined) {
    delete process.env.ORKESTRA_SUBAGENTS_DIR;
  } else {
    process.env.ORKESTRA_SUBAGENTS_DIR = originalSubagentsEnv;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-subagent-watcher-'));
  tempDirs.push(dir);
  return dir;
}

describe('SubagentStateWatcher', () => {
  it('matches by agentId, skips duplicate payloads, emits deltas, and stops polling on completion', async () => {
    const stateDir = await makeTempDir();
    const updates: SubagentUpdateEvent[] = [];
    const watcher = new SubagentStateWatcher({
      stateDir,
      intervalMs: 400,
      onUpdate: (ev) => updates.push(ev),
    });

    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({
        runId: RUN_1,
        provider: 'codex',
        model: 'GPT 6.2 Sol',
        effort: 'high',
        status: 'in_progress',
        startedAt: Date.now(),
        activities: [{ id: 'a1', kind: 'status', title: 'Başlatıldı', status: 'running' }],
      })
    );

    watcher.register({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'tool-1',
      agentId: RUN_1,
      title: 'Codex Alt Ajan',
      status: 'in_progress',
      parentToolCallId: null,
    });

    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({
      kind: 'subagent_update',
      toolCallId: 'tool-1',
      agentId: RUN_1,
      status: 'in_progress',
      provider: 'codex',
      model: 'GPT 6.2 Sol',
      effort: 'high',
    });

    // Polling again with unchanged file emits nothing.
    await watcher.poll();
    expect(updates).toHaveLength(1);

    // Updating the state file emits the completion update and removes the watcher entry.
    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({
        runId: RUN_1,
        provider: 'codex',
        model: 'GPT 6.2 Sol',
        effort: 'high',
        status: 'completed',
        summary: 'Tamamlandı',
        startedAt: Date.now(),
        activities: [{ id: 'a1', kind: 'message', title: 'Yanıt', status: 'done' }],
      })
    );

    await watcher.poll();
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      kind: 'subagent_update',
      toolCallId: 'tool-1',
      agentId: RUN_1,
      status: 'completed',
      summary: 'Tamamlandı',
    });
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('matches by prompt + startedAt window excluding already claimed runIds for parallel same-prompt calls', async () => {
    const stateDir = await makeTempDir();
    const updates: SubagentUpdateEvent[] = [];
    const watcher = new SubagentStateWatcher({
      stateDir,
      intervalMs: 400,
      onUpdate: (ev) => updates.push(ev),
    });

    const now = Date.now();
    // Stale file outside 8000ms window must not match.
    await writeFile(
      join(stateDir, `${RUN_3}.json`),
      JSON.stringify({
        runId: RUN_3,
        provider: 'claude',
        prompt: 'Aynı görev',
        startedAt: now - 20_000,
        status: 'in_progress',
      })
    );

    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({
        runId: RUN_1,
        provider: 'codex',
        prompt: 'Aynı görev',
        startedAt: now - 1000,
        status: 'in_progress',
        summary: 'Birinci',
      })
    );
    await writeFile(
      join(stateDir, `${RUN_2}.json`),
      JSON.stringify({
        runId: RUN_2,
        provider: 'kimi',
        prompt: 'Aynı görev',
        startedAt: now,
        status: 'in_progress',
        summary: 'İkinci',
      })
    );

    watcher.register(
      {
        kind: 'subagent',
        operation: 'start',
        toolCallId: 'call-a',
        title: 'Alt Ajan A',
        prompt: '  Aynı görev  ',
        status: 'in_progress',
        parentToolCallId: null,
      },
      now
    );
    watcher.register(
      {
        kind: 'subagent',
        operation: 'start',
        toolCallId: 'call-b',
        title: 'Alt Ajan B',
        prompt: 'Aynı görev',
        status: 'in_progress',
        parentToolCallId: null,
      },
      now
    );

    await vi.waitFor(() => expect(updates).toHaveLength(2));
    const claimedRunIds = new Set(updates.map((u) => u.agentId));
    expect(claimedRunIds).toEqual(new Set([RUN_1, RUN_2]));
    expect(claimedRunIds.has(RUN_3)).toBe(false);
    watcher.dispose();
  });

  it('deduplicates when an identical subagent_update event was already observed by runId', async () => {
    const stateDir = await makeTempDir();
    const updates: SubagentUpdateEvent[] = [];
    const watcher = new SubagentStateWatcher({
      stateDir,
      onUpdate: (ev) => updates.push(ev),
    });

    const activities = [
      { id: 's1', kind: 'tool' as const, title: 'Okunuyor', status: 'running' as const },
    ];
    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({
        runId: RUN_1,
        provider: 'antigravity',
        model: 'Gemini 4 Neon',
        effort: 'high',
        status: 'in_progress',
        summary: 'Ara çıktı',
        startedAt: Date.now(),
        activities,
      })
    );

    watcher.register({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'agy-1',
      agentId: 'agy-1',
      prompt: 'Araştır',
      title: 'Araştırıcı',
      status: 'in_progress',
      parentToolCallId: null,
    });
    watcher.observeEvent({
      kind: 'subagent_update',
      toolCallId: 'agy-1',
      agentId: RUN_1,
      provider: 'antigravity',
      model: 'Gemini 4 Neon',
      effort: 'high',
      status: 'in_progress',
      summary: 'Ara çıktı',
      activities,
    });

    await watcher.poll();
    expect(updates).toHaveLength(0);
    watcher.dispose();
  });
});

describe('cancelSubagentRun and SessionCell integration', () => {
  it('validates runId strictly as UUID and handles missing/completed files cleanly', async () => {
    const stateDir = await makeTempDir();
    const invalid = await cancelSubagentRun('../escape', stateDir);
    expect(isErr(invalid)).toBe(true);
    if (isErr(invalid)) expect(invalid.error.type).toBe('invalid_state');

    const missing = await cancelSubagentRun(RUN_1, stateDir);
    expect(missing).toEqual({ success: true, data: { cancelled: false } });

    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({ runId: RUN_1, status: 'completed', summary: 'Zaten bitti' })
    );
    const alreadyDone = await cancelSubagentRun(RUN_1, stateDir);
    expect(alreadyDone).toEqual({ success: true, data: { cancelled: false } });
    const persisted = JSON.parse(await readFile(join(stateDir, `${RUN_1}.json`), 'utf8'));
    expect(persisted.status).toBe('completed');
    expect(persisted.summary).toBe('Zaten bitti');
  });

  it('sends SIGTERM to running subagent pid, atomically updates state file, and notifies SessionCell immediately', async () => {
    const stateDir = await makeTempDir();
    process.env.ORKESTRA_SUBAGENTS_DIR = stateDir;

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
    });
    expect(typeof child.pid).toBe('number');
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      }
    );

    const startedAt = Date.now();
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, `${RUN_1}.json`),
      JSON.stringify({
        runId: RUN_1,
        pid: child.pid,
        provider: 'claude',
        model: 'Claude Sonnet 5.5',
        prompt: 'Uzun analiz yap',
        status: 'in_progress',
        startedAt,
      })
    );

    const agent = new FakeAcpAgent();
    const cell = new SessionCell({
      conversationId: 'conv-sub',
      providerId: 'claude',
      acpSessionId: 'session-1',
      agent,
      resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
      logger: noopLogger,
    });
    cell.applySessionReady();

    // Push subagent start while session is ready (and also works while working).
    cell.push({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'claude-tool-1',
      title: 'Claude Alt Ajan',
      prompt: 'Uzun analiz yap',
      status: 'in_progress',
      parentToolCallId: null,
    });

    await vi.waitFor(() => {
      expect(cell.transcript.agents[0]?.agentId).toBe(RUN_1);
    });

    const cancelResult = await cancelSubagentRun(RUN_1, stateDir);
    expect(cancelResult).toEqual({ success: true, data: { cancelled: true } });

    const exit = await exitPromise;
    expect(exit.signal).toBe('SIGTERM');

    const disk = JSON.parse(await readFile(join(stateDir, `${RUN_1}.json`), 'utf8'));
    expect(disk.status).toBe('failed');
    expect(disk.cancelled).toBe(true);
    expect(disk.summary).toBe('Alt ajan kullanıcı tarafından durduruldu.');

    expect(cell.transcript.agents[0]).toMatchObject({
      agentId: RUN_1,
      toolCallId: 'claude-tool-1',
      status: 'failed',
      summary: 'Alt ajan kullanıcı tarafından durduruldu.',
    });

    cell.dispose();
  });

  it('cleans up watcher timers on settleTurn and routes cancelSubagent through AcpRuntime', async () => {
    const stateDir = await makeTempDir();
    process.env.ORKESTRA_SUBAGENTS_DIR = stateDir;

    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.launchSession(makeStartInput({ conversationId: 'conv-rt-sub' }));

    await writeFile(
      join(stateDir, `${RUN_2}.json`),
      JSON.stringify({
        runId: RUN_2,
        pid: 999999,
        status: 'in_progress',
        prompt: 'Test',
        startedAt: Date.now(),
      })
    );

    const res = await rt.cancelSubagent(RUN_2);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.data).toEqual({ cancelled: true });

    const cell = new SessionCell({
      conversationId: 'conv-settle',
      providerId: 'codex',
      acpSessionId: 'session-2',
      agent: h.agent,
      resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
      logger: noopLogger,
    });
    cell.applySessionReady();
    cell.push({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'codex-1',
      prompt: 'Bekleyen görev',
      title: 'Codex',
      status: 'in_progress',
      parentToolCallId: null,
    });
    cell.settleTurn({ kind: 'done', reason: 'end_turn' });
    cell.dispose();
    await rt.dispose();
  });

  it('routes subagent_update cleanly during working phase and exposes cancelSubagent over the ACP wire contract', async () => {
    const stateDir = await makeTempDir();
    process.env.ORKESTRA_SUBAGENTS_DIR = stateDir;

    const fakeAgent = new FakeAcpAgent();
    const h = makeAcpHarness({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: fakeAgent.behavior.connect,
        enrich: (event, raw) => {
          if (event.kind === 'tool_call' && event.title.includes('run_subagent')) {
            const rawInput = (raw as { rawInput?: { prompt?: string; provider?: string } })
              .rawInput;
            return {
              kind: 'subagent',
              operation: 'start',
              toolCallId: event.toolCallId,
              title: 'Codex Alt Ajan',
              status: event.status,
              parentToolCallId: event.parentToolCallId,
              ...(rawInput?.prompt ? { prompt: rawInput.prompt } : {}),
              ...(rawInput?.provider ? { provider: rawInput.provider } : {}),
            };
          }
          return event;
        },
      },
    });
    let resolveTurn!: (value: { stopReason: 'end_turn' }) => void;
    fakeAgent.prompt = vi.fn(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          resolveTurn = resolve;
        })
    );
    const rt = new AcpRuntime(h.deps);
    const wire = createTestWire(acpApiContract, createAcpController(rt));

    try {
      await wire.client.launch(makeStartInput({ conversationId: 'conv-wire-sub' }));
      const promptPromise = rt.sendPrompt('conv-wire-sub', { text: 'Çalış' });

      await vi.waitFor(() => expect(rt.getSessionState('conv-wire-sub').lifecycle).toBe('working'));

      await writeFile(
        join(stateDir, `${RUN_1}.json`),
        JSON.stringify({
          runId: RUN_1,
          pid: 999999,
          provider: 'codex',
          model: 'GPT 6.2 Sol',
          prompt: 'Çalışan alt ajan',
          status: 'in_progress',
          startedAt: Date.now(),
          activities: [{ id: 'a1', kind: 'tool', title: 'Aranıyor', status: 'running' }],
        })
      );

      fakeAgent.capturedClient!.sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'codex-call-1',
          title: 'mcp__orkestra-subagents__run_subagent',
          kind: 'other',
          status: 'in_progress',
          rawInput: {
            provider: 'codex',
            model: 'gpt-6.2-sol',
            prompt: 'Çalışan alt ajan',
          },
        } as never,
      });

      const live = rt.sessionLiveModels('conv-wire-sub');
      await vi.waitFor(() => {
        expect(peek(live!.states.agents)).toMatchObject([
          {
            agentId: RUN_1,
            toolCallId: 'codex-call-1',
            status: 'running',
            model: 'GPT 6.2 Sol',
          },
        ]);
      });

      const cancelled = await wire.client.cancelSubagent({ runId: RUN_1 });
      expect(cancelled).toEqual({ success: true, data: { cancelled: true } });

      await vi.waitFor(() => {
        expect(peek(live!.states.agents)).toMatchObject([
          {
            agentId: RUN_1,
            status: 'failed',
            summary: 'Alt ajan kullanıcı tarafından durduruldu.',
          },
        ]);
      });

      const disk = JSON.parse(await readFile(join(stateDir, `${RUN_1}.json`), 'utf8'));
      expect(disk.status).toBe('failed');
      expect(disk.cancelled).toBe(true);
      expect(disk.summary).toBe('Alt ajan kullanıcı tarafından durduruldu.');

      resolveTurn({ stopReason: 'end_turn' });
      await promptPromise;
    } finally {
      wire.dispose();
      await rt.dispose();
    }
  });

  it('records child pid in builtin-subagents-mcp bridge and sets Turkish cancel state on SIGTERM', async () => {
    const root = await makeTempDir();
    const stateDir = join(root, 'subagents');
    const mcpDir = join(root, 'mcp');
    const binDir = join(root, 'bin');
    await mkdir(stateDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const fakeAgy = join(binDir, 'agy');
    await writeFile(
      fakeAgy,
      `#!${process.execPath}
if (process.argv.includes('models')) {
  process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');
  process.exit(0);
}
setInterval(() => {}, 1000);
`,
      'utf8'
    );
    await chmod(fakeAgy, 0o755);

    const bridgePath = materializeBuiltinSubagentsBridge({ stateDir: mcpDir });
    const mcp = spawn(process.execPath, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ORKESTRA_SUBAGENTS_DIR: stateDir,
        ORKESTRA_AGY_EXECUTABLE: fakeAgy,
      },
    });
    const stderrChunks: string[] = [];
    mcp.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));

    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      let buf = '';
      mcp.once('error', reject);
      mcp.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          resolve(JSON.parse(buf.split('\n')[0]) as Record<string, unknown>);
        }
      });
    });

    mcp.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'run_subagent',
          arguments: {
            provider: 'antigravity',
            model: 'gemini-4-neon-high',
            prompt: 'Uyuyan görev',
          },
        },
      }) + '\n'
    );

    let runId: string | null = null;
    await vi.waitFor(
      async () => {
        const files = (await readdir(stateDir)).filter((f) => f.endsWith('.json'));
        expect(files, `stderr=${stderrChunks.join('')}`).toHaveLength(1);
        const data = JSON.parse(await readFile(join(stateDir, files[0]), 'utf8')) as {
          runId: string;
          pid?: number;
        };
        expect(typeof data.pid).toBe('number');
        expect(data.pid!).toBeGreaterThan(0);
        runId = data.runId;
      },
      { timeout: 5000 }
    );

    const cancelled = await cancelSubagentRun(runId!, stateDir);
    expect(cancelled).toEqual({ success: true, data: { cancelled: true } });

    const mcpReply = await responsePromise;
    const contentText = (
      mcpReply as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }
    ).result?.content?.[0]?.text;
    expect(mcpReply).toMatchObject({ result: { isError: true } });
    const parsedReply = JSON.parse(contentText!) as { ok: boolean; error?: string };
    expect(parsedReply.ok).toBe(false);
    expect(parsedReply.error).toBe('Alt ajan kullanıcı tarafından durduruldu.');

    const finalDisk = JSON.parse(await readFile(join(stateDir, `${runId!}.json`), 'utf8')) as {
      status: string;
      cancelled: boolean;
      summary: string;
    };
    expect(finalDisk.status).toBe('failed');
    expect(finalDisk.cancelled).toBe(true);
    expect(finalDisk.summary).toBe('Alt ajan kullanıcı tarafından durduruldu.');

    mcp.kill();
  });
});
