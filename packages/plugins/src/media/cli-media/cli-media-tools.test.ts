import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_SPEC } from '../flow/flow-tools';
import { HIGGSFIELD_SPEC } from '../higgsfield/higgsfield-tools';
import { createMediaToolHandler, findMediaReferences, nodeCliRunner } from './cli-media-tools';

/** `higgsfield model list --image --json` çıktısından alınmış kısa örnek. */
const HF_MODELS = JSON.stringify([
  { display_name: '3D Jutsu Angles', job_type: '3d_jutsu_angles', type: 'image' },
  { display_name: 'GPT Image 2', job_type: 'gpt_image_2', type: 'image' },
]);
/** `gflow models --json` çıktısının biçimi (kısaltılmış). */
const FLOW_MODELS = JSON.stringify({
  image: {
    models: [{ name: 'NARWHAL', label: 'Nano Banana 2.1', aliases: ['nano2'], ref_cap: 10 }],
  },
  video: { models: [{ name: 'veo_3_1_lite', aliases: ['veo-lite'], durations: [4, 6, 8] }] },
});

type Fake = { dir: string; cli: string; log: string; outputDir: string };

/** argv'yi kaydedip `responses` tablosundaki ilk eşleşen çıktıyı basan sahte CLI. */
async function createFakeCli(responses: Record<string, { stdout: string; code?: number }>) {
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-media-cli-'));
  const cli = join(dir, 'fake-cli');
  const log = join(dir, 'calls.jsonl');
  await writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const responses = ${JSON.stringify(responses)};
const key = Object.keys(responses).find((prefix) => argv.join(' ').startsWith(prefix));
const response = key ? responses[key] : { stdout: '' };
process.stdout.write(response.stdout.replace('$OUT', argv[argv.indexOf('--out') + 1] || argv[argv.indexOf('--out-dir') + 1] || ''));
process.exit(response.code || 0);
`
  );
  await chmod(cli, 0o755);
  return { dir, cli, log, outputDir: join(dir, 'conversation', 'orkestra-media') } satisfies Fake;
}

async function calls(fake: Fake): Promise<string[][]> {
  const raw = await readFile(fake.log, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe('CLI media tools', () => {
  let fake: Fake;
  const download = vi.fn(async (_url: string, destination: string) => {
    await writeFile(destination, 'png-bytes');
  });

  beforeEach(async () => {
    download.mockClear();
    fake = await createFakeCli({
      'model list --image --json': { stdout: HF_MODELS },
      'account status --json': {
        stdout: JSON.stringify({
          credits: 120,
          email: 'someone@example.com',
          subscription_plan_type: 'pro',
        }),
      },
      'generate create gpt_image_2': {
        stdout: JSON.stringify({
          id: 'job-1',
          status: 'completed',
          credits_spent: 4,
          results: [{ url: 'https://cdn.example.test/out/job-1.png' }],
        }),
      },
      'generate create fail_model': { stdout: '{"error":"insufficient credits"}', code: 3 },
      'image generate': { stdout: '{"mode":"t2i","files":["$OUT/flow_1.png"],"credits":10}' },
      'models --json': { stdout: FLOW_MODELS },
    });
  });

  afterEach(async () => {
    await rm(fake.dir, { recursive: true, force: true });
  });

  const higgsfield = (requireConfirmation = true) =>
    createMediaToolHandler(HIGGSFIELD_SPEC, {
      run: nodeCliRunner,
      executable: fake.cli,
      outputDir: fake.outputDir,
      requireConfirmation,
      download,
      now: () => 1_700_000_000_000,
    });

  it('lists tools with cost notes, confirmation flags and annotations', () => {
    const tools = higgsfield().listTools();
    const generate = tools.find((tool) => tool.name === 'higgsfield_generate_image')!;
    expect(generate.description).toContain("SPENDS the user's Higgsfield credits");
    expect(generate.inputSchema.properties).toHaveProperty('confirm_spend');
    expect(generate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const list = tools.find((tool) => tool.name === 'higgsfield_list_models')!;
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(list.inputSchema.properties).not.toHaveProperty('confirm_spend');
    expect(FLOW_SPEC.tools.map((tool) => tool.name)).toEqual([
      'flow_list_models',
      'flow_credits',
      'flow_generate_image',
      'flow_generate_video',
      'flow_fetch_result',
    ]);
  });

  it('runs read-only tools with exact argv and passes the output through', async () => {
    const result = await higgsfield().callTool('higgsfield_list_models', { type: 'image' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual(JSON.parse(HF_MODELS));
    expect(await calls(fake)).toEqual([['model', 'list', '--image', '--json']]);
  });

  it('hides the account email in the balance output', async () => {
    const result = await higgsfield().callTool('higgsfield_balance', {});
    expect(text(result)).toContain('"credits": 120');
    expect(text(result)).not.toContain('someone@example.com');
  });

  it('previews a generation without running the CLI until the spend is confirmed', async () => {
    const args = { model: 'gpt_image_2', prompt: 'studio photo of a lamp' };
    const preview = await higgsfield().callTool('higgsfield_generate_image', args);
    expect(text(preview)).toMatch(/^Not run: Higgsfield generation spends the user's credits\./);
    expect(text(preview)).toContain('confirm_spend: true');
    expect(await calls(fake)).toEqual([]);

    const run = await higgsfield().callTool('higgsfield_generate_image', {
      ...args,
      params: { aspect_ratio: '1:1' },
      confirm_spend: true,
    });
    expect(run.isError).toBeUndefined();
    expect(await calls(fake)).toEqual([
      [
        'generate',
        'create',
        'gpt_image_2',
        '--prompt',
        'studio photo of a lamp',
        '--aspect_ratio',
        '1:1',
        '--wait',
        '--wait-timeout',
        '10m',
        '--json',
      ],
    ]);
    expect(download).toHaveBeenCalledTimes(1);
    const [url, destination] = download.mock.calls[0]!;
    expect(url).toBe('https://cdn.example.test/out/job-1.png');
    expect(destination.startsWith(fake.outputDir)).toBe(true);
    expect(text(run)).toContain('"credits_spent":4');
    expect(text(run)).toContain(`- ${destination}`);
  });

  it('runs immediately when confirmation is turned off', async () => {
    await higgsfield(false).callTool('higgsfield_generate_image', {
      model: 'gpt_image_2',
      prompt: 'x',
    });
    expect(await calls(fake)).toHaveLength(1);
  });

  it('never retries a failed generation and warns the agent', async () => {
    const result = await higgsfield().callTool('higgsfield_generate_video', {
      model: 'fail_model',
      prompt: 'x',
      confirm_spend: true,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('exited with code 3');
    expect(text(result)).toContain('insufficient credits');
    expect(text(result)).toContain('Do NOT retry automatically');
    expect(await calls(fake)).toHaveLength(1);
  });

  it('rejects unsafe parameters before running anything', async () => {
    const handler = higgsfield(false);
    const bad = await handler.callTool('higgsfield_generate_image', {
      model: 'gpt_image_2',
      prompt: 'x',
      params: { json: true },
    });
    expect(bad.isError).toBe(true);
    const flag = await handler.callTool('higgsfield_generate_image', {
      model: '--help',
      prompt: 'x',
    });
    expect(flag.isError).toBe(true);
    const image = await handler.callTool('higgsfield_generate_image', {
      model: 'gpt_image_2',
      prompt: 'x',
      image: '--rm',
    });
    expect(image.isError).toBe(true);
    expect(await calls(fake)).toEqual([]);
  });

  it('writes Flow images into the conversation output directory', async () => {
    const flow = createMediaToolHandler(FLOW_SPEC, {
      run: nodeCliRunner,
      executable: fake.cli,
      outputDir: fake.outputDir,
      requireConfirmation: true,
      download,
    });
    const models = await flow.callTool('flow_list_models', {});
    expect(JSON.parse(text(models)).image.models[0].aliases).toContain('nano2');
    const result = await flow.callTool('flow_generate_image', {
      prompt: 'a lake at dawn',
      aspect: '16:9',
      confirm_spend: true,
    });
    expect(result.isError).toBeUndefined();
    const recorded = await calls(fake);
    expect(recorded[1]).toEqual([
      'image',
      'generate',
      '--count',
      '1',
      '--aspect',
      '16:9',
      '--out',
      fake.outputDir,
      '--json',
      '--',
      'a lake at dawn',
    ]);
    expect(text(result)).toContain(`- ${join(fake.outputDir, 'flow_1.png')}`);
    expect(download).not.toHaveBeenCalled();
  });

  it('finds media references in JSON and plain output', () => {
    expect(
      findMediaReferences('{"a":{"url":"https://x.test/a.mp4?sig=1"},"p":"/tmp/b.png","n":"x.txt"}')
    ).toEqual({ files: ['/tmp/b.png'], urls: ['https://x.test/a.mp4?sig=1'] });
    expect(findMediaReferences('saved /tmp/out/c.webm (12 MB)')).toEqual({
      files: ['/tmp/out/c.webm'],
      urls: [],
    });
  });
});

describe('media MCP stdio bridge', () => {
  it('serves tools/list and tools/call over stdio with the fake CLI', async () => {
    const fake = await createFakeCli({ 'models --json': { stdout: FLOW_MODELS } });
    const packageDir = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
    const tsx = join(packageDir, '..', '..', 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, [join(packageDir, 'src/media/flow/mcp-bridge.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: fake.dir,
        ORKESTRA_MEDIA_CLI: fake.cli,
        ORKESTRA_MEDIA_OUTPUT_DIR: fake.outputDir,
      },
    });
    try {
      const responses = new Map<number, Record<string, unknown>>();
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const message = JSON.parse(buffer.slice(0, index)) as { id: number };
          responses.set(message.id, message);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
      const send = (id: number, method: string, params: Record<string, unknown> = {}) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      send(1, 'initialize', { protocolVersion: '2025-06-18' });
      send(2, 'tools/list');
      send(3, 'tools/call', { name: 'flow_list_models', arguments: {} });
      send(4, 'tools/call', { name: 'flow_generate_video', arguments: { prompt: 'x' } });
      await vi.waitFor(() => expect(responses.size).toBe(4), { timeout: 15_000 });
      expect(responses.get(1)).toMatchObject({
        result: { serverInfo: { name: 'orkestra-flow' }, protocolVersion: '2025-06-18' },
      });
      const tools = (responses.get(2) as { result: { tools: Array<{ name: string }> } }).result
        .tools;
      expect(tools.map((tool) => tool.name)).toContain('flow_generate_video');
      const list = responses.get(3) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(list.result.content[0]!.text).video.models[0].name).toBe('veo_3_1_lite');
      const preview = responses.get(4) as { result: { content: Array<{ text: string }> } };
      expect(preview.result.content[0]!.text).toMatch(/^Not run: Google Flow generation/);
      expect(await calls(fake)).toEqual([['models', '--json']]);
    } finally {
      child.kill('SIGKILL');
      await rm(fake.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
