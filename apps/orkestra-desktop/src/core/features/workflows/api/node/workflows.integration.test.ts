import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStepExecutor, AgentStepOutcome, AgentStepRequest } from './engine';
import { CodeWorkflowService } from './service';

const logger = { info: () => undefined, warn: () => undefined };

// Gerçek bir iş akışı dosyası: TypeScript türleri, göreli içe aktarma ve Orkestra global'i.
const FIXTURE = `import { shout } from './lib/helper.mjs';

const { workflow, step, agent, title, z } = Orkestra;

type Counts = Record<string, number>;
const counts: Counts = ((globalThis as { __fixtureCounts?: Counts }).__fixtureCounts ??= {});

export default workflow(
  'fixture',
  { version: 1, payload: z.object({ name: z.string() }) },
  async (payload: { name: string }) => {
    title(\`Fixture \${payload.name}\`);
    const prepared = await step('prepare', () => {
      counts.prepare = (counts.prepare ?? 0) + 1;
      return \`prepared \${payload.name}\`;
    });
    const review = (await agent('review', {
      task: 'task-1',
      provider: 'claude',
      brief: prepared,
    })) as { value: string };
    return step('finish', () => {
      counts.finish = (counts.finish ?? 0) + 1;
      return shout(review.value);
    });
  }
);
`;

const HELPER = `export const shout = (text) => text.toUpperCase();\n`;

function counts(): Record<string, number> {
  return ((globalThis as { __fixtureCounts?: Record<string, number> }).__fixtureCounts ??= {});
}

function agents(hold: boolean) {
  const requests: AgentStepRequest[] = [];
  let release: (() => void) | null = null;
  const executor: AgentStepExecutor = {
    run(request) {
      requests.push(request);
      const conversationId = `conv-${requests.length}`;
      request.onConversation({ conversationId, projectId: 'project-1', taskId: 'task-1' });
      const done: AgentStepOutcome = {
        status: 'done',
        report: `looked at ${request.brief}`,
        conversationId,
      };
      if (!hold) return Promise.resolve(done);
      return new Promise((resolve) => {
        release = () => resolve(done);
        request.signal.addEventListener(
          'abort',
          () =>
            resolve({
              status: 'failed',
              message: 'stopped',
              started: true,
              retryable: false,
              conversationId,
            }),
          { once: true }
        );
      });
    },
    followUp: async () => ({
      status: 'failed',
      message: 'unused',
      started: true,
      retryable: false,
      conversationId: null,
    }),
  };
  return { executor, requests, release: () => release?.() };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let root: string;
let folder: string;
let dataDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orkestra-workflows-it-'));
  folder = join(root, 'workflows');
  dataDirectory = join(root, 'data');
  await mkdir(join(folder, 'lib'), { recursive: true });
  await writeFile(join(folder, 'fixture.ts'), FIXTURE);
  await writeFile(join(folder, 'lib', 'helper.mjs'), HELPER);
  delete (globalThis as { __fixtureCounts?: unknown }).__fixtureCounts;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(executor: AgentStepExecutor, enabled = true) {
  return new CodeWorkflowService({
    dataDirectory,
    folder,
    logger,
    agents: executor,
    isEnabled: async () => enabled,
    engine: { autoTick: false },
  });
}

describe('code workflows end to end', () => {
  it('loads a workflow file, survives being killed mid-run and resumes without redoing steps', async () => {
    const first = agents(true);
    const before = service(first.executor);
    await before.refresh();
    const status = await before.status();
    expect(status.problems).toEqual([]);
    expect(status.definitions.map((definition) => [definition.name, definition.version])).toEqual([
      ['fixture', 1],
    ]);

    expect(await before.start({ workflow: 'fixture', input: '{"name":1}' })).toMatchObject({
      ok: false,
    });
    const started = await before.start({ workflow: 'fixture', input: '{"name":"demo"}' });
    if (!started.ok) throw new Error(started.error);
    await waitFor(() => first.requests.length === 1);
    expect(first.requests[0]).toMatchObject({
      task: 'task-1',
      provider: 'claude',
      brief: 'prepared demo',
    });
    expect(counts()).toEqual({ prepare: 1 });

    // Uygulama ajan adımının ortasında kapanır.
    await before.dispose();
    const onDisk = JSON.parse(
      await readFile(join(dataDirectory, 'workflows', 'runs', `${started.runId}.json`), 'utf8')
    ) as { status: string; title: string; entries: { name: string; status: string }[] };
    expect(onDisk.status).toBe('running');
    expect(onDisk.title).toBe('Fixture demo');
    expect(onDisk.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ['prepare', 'completed'],
      ['review', 'running'],
    ]);

    // Yeni süreç: aynı klasör ve kayıtlarla yeniden kurulur; ilk bitmemiş adımdan sürer.
    const second = agents(false);
    const after = service(second.executor);
    await after.refresh();
    await after.activeEngine!.settled(started.runId);
    const run = await after.getRun(started.runId);
    expect(run?.status).toBe('completed');
    expect(run?.result).toBe('LOOKED AT PREPARED DEMO');
    expect(counts()).toEqual({ prepare: 1, finish: 1 });
    expect(second.requests).toHaveLength(1);
    expect(run?.entries.find((entry) => entry.name === 'review')?.agent).toMatchObject({
      conversationId: 'conv-1',
      projectId: 'project-1',
      taskId: 'task-1',
      conversations: ['conv-1'],
    });
    await after.dispose();
  });

  it('hot-reloads edits, keeps the last good version of a broken file and stays off when disabled', async () => {
    const live = service(agents(false).executor);
    await live.refresh();
    await writeFile(join(folder, 'fixture.ts'), FIXTURE.replace('version: 1', 'version: 2'));
    await live.reloadDefinitions();
    expect((await live.status()).definitions.map((definition) => definition.version)).toEqual([2]);

    await writeFile(
      join(folder, 'broken.ts'),
      "const { workflow } = Orkestra;\n\nworkflow('x', {}, async () => 1);\n"
    );
    await writeFile(join(folder, 'bad name.ts'), 'export default 1;');
    await live.reloadDefinitions();
    const status = await live.status();
    expect(status.definitions.map((definition) => definition.name)).toEqual(['fixture']);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toMatchObject({ file: join(folder, 'broken.ts'), line: 3 });
    expect(status.problems[0]!.message).toContain('integer version');
    await live.dispose();

    const off = service(agents(false).executor, false);
    await off.refresh();
    expect(await off.status()).toMatchObject({ enabled: false, definitions: [] });
    expect(await off.start({ workflow: 'fixture', input: '' })).toMatchObject({ ok: false });
    await off.dispose();
  });
});
