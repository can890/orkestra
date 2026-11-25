import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import {
  buildBuiltinSubagentsMcpRegistration,
  createBuiltinSubagentsParentConfiguration,
} from './builtin-subagents-mcp';

it.skipIf(process.platform === 'win32')(
  'passes the current parent model and bounded effort to the delegated CLI',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orkestra-subagent-bridge-test-'));
    const configuration = createBuiltinSubagentsParentConfiguration({
      model: 'gemini-4-neon-medium',
      effort: 'medium',
    });
    const cli = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'models') {
  console.log('gemini-4-neon-medium\\tGemini Neon Medium\\ngemini-4-carbon-high\\tGemini Carbon High');
} else {
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: args.join('\\n') } }));
}
`;
    const executable = join(directory, 'agy');
    await writeFile(executable, cli, { mode: 0o700 });
    const registration = buildBuiltinSubagentsMcpRegistration({
      stateDir: directory,
      parentProvider: 'antigravity',
      parentConfigurationPath: configuration.path,
    });
    const bridge = spawn(process.execPath, registration.args ?? [], {
      env: {
        ...process.env,
        ...registration.env,
        ORKESTRA_AGY_EXECUTABLE: executable,
        ORKESTRA_SUBAGENTS_DIR: join(directory, 'runs'),
        ORKESTRA_SUBAGENTS_ROUTING_FILE: join(directory, 'missing-routing.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
    async function run(id: number, argumentsOverride: Record<string, unknown> = {}) {
      bridge.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'run_subagent',
            arguments: { prompt: 'Test delegation', cwd: directory, ...argumentsOverride },
          },
        }) + '\n'
      );
      const line = await lines.next();
      if (line.done) throw new Error('The MCP bridge closed before responding');
      const result = JSON.parse(line.value).result;
      expect(result.isError, result.content[0]?.text).toBe(false);
      return JSON.parse(result.content[0].text);
    }

    try {
      const medium = await run(1);
      expect(medium).toMatchObject({ modelSlug: 'gemini-4-neon-medium', effort: 'medium' });
      expect(medium.response).toContain('--effort\nmedium');

      configuration.update({ model: 'gemini-4-carbon-xhigh', effort: 'ultra' });
      const high = await run(2);
      expect(high).toMatchObject({ modelSlug: 'gemini-4-carbon-high', effort: 'high' });
      expect(high.response).toContain('--effort\nhigh');

      configuration.update({ model: 'gemini-pro-orchestrator-neon', effort: 'ultra' });
      const native = await run(3, {
        provider: 'antigravity',
        model: 'gemini-4-neon-medium',
        effort: 'max',
      });
      expect(native).toMatchObject({ modelSlug: 'gemini-4-neon-medium', effort: 'max' });
      expect(native.response).toContain('--effort\nmax');
    } finally {
      bridge.kill();
      configuration.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
