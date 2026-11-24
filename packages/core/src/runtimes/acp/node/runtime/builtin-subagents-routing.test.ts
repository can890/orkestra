import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SubagentRoutingPolicy,
  SubagentRoutingSnapshot,
} from '#runtimes/acp/api/subagent-routing';
import { materializeBuiltinSubagentsBridge } from './builtin-subagents-mcp';

/**
 * Yerleşik `orkestra-subagents` köprüsünü gerçek süreç olarak çalıştırır; tüm sağlayıcı CLI'ları
 * geçici HOME altındaki sahte betiklerdir (gerçek ajan asla başlatılmaz). Yönlendirme kapalıyken
 * çıktının bugünküyle aynı kaldığını, açıkken kararın ajana ve panele iletildiğini doğrular.
 */

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: unknown };

class BridgeClient {
  private buffer = '';
  private readonly pending = new Map<number, (value: RpcResponse) => void>();
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          const message = JSON.parse(line) as RpcResponse;
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) };
  }
}

const POLICY: SubagentRoutingPolicy = {
  thresholdPercent: 10,
  avoidParentScarceModels: true,
  scarceModels: ['claude-fable-*'],
  tiers: [
    {
      id: 'execution',
      label: 'Execution',
      enabled: true,
      candidates: [
        { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high', enabled: true },
        { provider: 'claude', model: 'claude-sonnet-5-5', enabled: true },
      ],
    },
    {
      id: 'judgment',
      label: 'Judgment',
      enabled: true,
      candidates: [
        { provider: 'claude', model: 'claude-fable-5-2', enabled: true },
        { provider: 'claude', model: 'claude-opus-5-5', enabled: true },
      ],
    },
  ],
};

function fakeCli(logFile: string, output: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
  process.stdout.write(${JSON.stringify(output)} + '\\n');
});
`;
}

describe('orkestra-subagents bridge with limit-aware routing', () => {
  let root: string;
  let routingFile: string;
  let stateDir: string;
  let logFile: string;
  let child: ChildProcessWithoutNullStreams;
  let client: BridgeClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orkestra-routing-bridge-'));
    const bin = join(root, 'home', '.local', 'bin');
    await mkdir(bin, { recursive: true });
    stateDir = join(root, 'state', 'subagents');
    routingFile = join(root, 'state', 'subagent-routing.json');
    logFile = join(root, 'cli-calls.jsonl');
    const scripts: Record<string, string> = {
      codex: JSON.stringify({
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'codex done' },
      }),
      claude: JSON.stringify({ type: 'result', result: 'claude done' }),
    };
    for (const [name, output] of Object.entries(scripts)) {
      const path = join(bin, name);
      await writeFile(path, fakeCli(logFile, output));
      await chmod(path, 0o755);
    }
    // `agy models` stdin beklemeden model listesini basar.
    await writeFile(
      join(bin, 'agy'),
      `#!${process.execPath}\nprocess.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');\n`
    );
    await chmod(join(bin, 'agy'), 0o755);
    const bridgePath = materializeBuiltinSubagentsBridge({ stateDir: join(root, 'mcp') });
    child = spawn(process.execPath, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: join(root, 'home'),
        PATH: `${bin}:/usr/bin:/bin`,
        ORKESTRA_SUBAGENTS_DIR: stateDir,
        ORKESTRA_SUBAGENTS_ROUTING_FILE: routingFile,
        ORKESTRA_SUBAGENTS_PARENT_PROVIDER: 'claude',
        ORKESTRA_AGY_EXECUTABLE: join(bin, 'agy'),
      },
    });
    client = new BridgeClient(child);
  });

  afterEach(async () => {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  async function writeSnapshot(enabled: boolean, codexRemaining: number) {
    const now = Date.now();
    const snapshot: SubagentRoutingSnapshot = {
      version: 1,
      enabled,
      writtenAt: now,
      policy: POLICY,
      headroom: {
        codex: {
          remainingPercent: codexRemaining,
          windowLabel: '5-hour',
          resetsAt: new Date(now + 3600_000).toISOString(),
          measuredAt: new Date(now - 30_000).toISOString(),
        },
        claude: {
          remainingPercent: 80,
          windowLabel: 'weekly',
          resetsAt: new Date(now + 86_400_000).toISOString(),
          measuredAt: new Date(now - 30_000).toISOString(),
        },
      },
    };
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(routingFile, JSON.stringify(snapshot));
  }

  async function cliCalls(): Promise<Array<{ argv: string[] }>> {
    const raw = await readFile(logFile, 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[] });
  }

  async function runStates() {
    const files = (await readdir(stateDir)).filter((f) => f.endsWith('.json'));
    return Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(stateDir, f), 'utf8')))
    );
  }

  it('OFF: output is unchanged whether the snapshot is missing or disabled', async () => {
    const listWithoutFile = await client.request('tools/list');
    const modelsWithoutFile = await client.callTool('list_subagent_models', {});
    await writeSnapshot(false, 0);
    const listDisabled = await client.request('tools/list');
    const modelsDisabled = await client.callTool('list_subagent_models', {});

    expect(listDisabled.result).toEqual(listWithoutFile.result);
    const runTool = (listDisabled.result!.tools as Array<{ name: string; inputSchema: any }>).find(
      (tool) => tool.name === 'run_subagent'
    )!;
    expect(Object.keys(runTool.inputSchema.properties)).toEqual([
      'provider',
      'model',
      'effort',
      'role',
      'prompt',
      'cwd',
    ]);
    expect(modelsDisabled.json).toEqual(modelsWithoutFile.json);
    expect(modelsDisabled.json.routing).toBeUndefined();
    expect(modelsDisabled.json.codex.headroom).toBeUndefined();

    // Codex %0 olsa bile kapalıyken istenen model aynen çalışır ve sonuçta yönlendirme alanı yoktur.
    const run = await client.callTool('run_subagent', {
      provider: 'codex',
      model: 'gpt-6.2-astra',
      prompt: 'özetle',
    });
    expect(run.isError).toBe(false);
    expect(run.json.routing).toBeUndefined();
    expect(run.json.response).toBe('codex done');
    const [call] = await cliCalls();
    expect(call!.argv).toContain('gpt-6.2-astra');
    const [state] = await runStates();
    expect(state.routing).toBeUndefined();
    expect(state.activities.some((a: { id: string }) => a.id === 'route-0')).toBe(false);
  });

  it('ON: annotates models, reroutes an exhausted pool and records the decision', async () => {
    await writeSnapshot(true, 3);

    const list = await client.request('tools/list');
    const runTool = (list.result!.tools as Array<{ name: string; inputSchema: any }>).find(
      (tool) => tool.name === 'run_subagent'
    )!;
    expect(runTool.inputSchema.properties.tier.enum).toEqual(['execution', 'judgment']);

    const models = await client.callTool('list_subagent_models', {});
    expect(models.json.codex.headroom).toMatchObject({ state: 'low', remainingPercent: 3 });
    expect(models.json.claude.headroom).toMatchObject({ state: 'ok', remainingPercent: 80 });
    expect(models.json.routing.recommended.execution).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5-5',
    });
    // Ebeveyn Claude: kıt Fable önerilmez.
    expect(models.json.routing.recommended.judgment).toMatchObject({ model: 'claude-opus-5-5' });

    const run = await client.callTool('run_subagent', {
      provider: 'codex',
      model: 'gpt-6.2-astra',
      prompt: 'özetle',
    });
    expect(run.isError).toBe(false);
    expect(run.json.provider).toBe('claude');
    expect(run.json.modelSlug).toBe('claude-sonnet-5-5');
    expect(run.json.response).toBe('claude done');
    expect(run.json.routing).toMatchObject({
      action: 'reroute',
      requested: { provider: 'codex', model: 'gpt-6.2-astra' },
      routedTo: { provider: 'claude', model: 'claude-sonnet-5-5' },
      tier: 'execution',
    });
    expect(run.json.routing.note).toMatch(
      /^requested codex\/gpt-6\.2-astra, routed to claude\/claude-sonnet-5-5 because codex\/gpt-6\.2-astra is at 97% of its 5-hour window, resets \d\d:\d\d$/
    );
    const calls = await cliCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toContain('claude-sonnet-5-5');

    const [state] = await runStates();
    expect(state.routing.action).toBe('reroute');
    expect(state.activities[0]).toMatchObject({ id: 'route-0', kind: 'status' });
    expect(state.activities[0].title).toBe('Rerouted to claude/claude-sonnet-5-5');
  });

  it('ON: picks by policy when no model is named and never spawns the parent’s scarce model implicitly', async () => {
    await writeSnapshot(true, 60);
    const run = await client.callTool('run_subagent', { tier: 'judgment', prompt: 'incele' });
    expect(run.json.routing).toMatchObject({
      action: 'pick',
      routedTo: { provider: 'claude', model: 'claude-opus-5-5' },
    });
    expect((await cliCalls())[0]!.argv).toContain('claude-opus-5-5');

    const explicit = await client.callTool('run_subagent', {
      provider: 'claude',
      model: 'claude-fable-5-2',
      prompt: 'incele',
    });
    expect(explicit.json.routing).toMatchObject({ action: 'keep', note: null });
    expect((await cliCalls())[1]!.argv).toContain('claude-fable-5-2');
  });
});
