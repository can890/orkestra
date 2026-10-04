import type { CLIAgentPluginProvider } from '@orkestra/core/services/agent-plugins/api/plugins';
import { createPluginRegistry } from '@orkestra/shared/plugins';
import { describe, expect, it } from 'vitest';
import { provider as auggie } from './auggie';
import { provider as cline } from './cline';
import { provider as codebuddy } from './codebuddy';
import { provider as copilot } from './copilot';
import { provider as cursor } from './cursor';
import { provider as devin } from './devin';
import { provider as droid } from './droid';
import { provider as goose } from './goose';
import { provider as grok } from './grok';
import { provider as hermes } from './hermes';
import { provider as junie } from './junie';
import { provider as kilocode } from './kilocode';
import { provider as kimi } from './kimi';
import { provider as kiro } from './kiro';
import { provider as mimocode } from './mimocode';
import { provider as mistral } from './mistral';
import { provider as ohMyPi } from './oh-my-pi';
import { provider as primeAgent } from './prime-agent';
import { provider as qoder } from './qoder';
import { provider as qwen } from './qwen';

// Test provider implementations independently of the curated application registry.
const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();
for (const provider of [
  auggie,
  cline,
  codebuddy,
  copilot,
  cursor,
  devin,
  droid,
  goose,
  grok,
  hermes,
  junie,
  kilocode,
  kimi,
  kiro,
  mimocode,
  ohMyPi,
  primeAgent,
  mistral,
  qoder,
  qwen,
]) {
  pluginRegistry.register(provider);
}

const spawnCtx = {
  cwd: '/home/user/worktrees/task-1',
  env: {},
  cli: '/usr/local/bin/agent',
};

const nativeAcpProviders: Array<{
  id: string;
  cli?: string;
  args: string[];
  command?: string;
  env?: Record<string, string>;
}> = [
  {
    id: 'auggie',
    args: ['--acp'],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  { id: 'cline', args: ['--acp'] },
  { id: 'codebuddy', args: ['--acp'] },
  { id: 'copilot', args: ['--acp'] },
  { id: 'cursor', args: ['acp'] },
  { id: 'devin', args: ['acp'] },
  {
    id: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    env: {
      DROID_DISABLE_AUTO_UPDATE: 'true',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
    },
  },
  { id: 'goose', args: ['acp'] },
  { id: 'grok', args: ['agent', 'stdio'] },
  { id: 'hermes', args: ['acp'] },
  { id: 'junie', args: ['--acp=true'] },
  { id: 'kilocode', args: ['acp'] },
  { id: 'kimi', args: ['acp'] },
  { id: 'kiro', args: ['acp'] },
  { id: 'mimocode', args: ['acp'] },
  { id: 'oh-my-pi', args: ['acp'] },
  { id: 'prime-agent', args: ['--mode', 'acp'] },
  {
    id: 'mistral',
    cli: '/usr/local/bin/vibe',
    command: '/usr/local/bin/vibe-acp',
    args: [],
  },
  {
    id: 'mistral',
    cli: 'vibe.cmd',
    command: 'vibe-acp.cmd',
    args: [],
  },
  { id: 'qoder', args: ['--acp'] },
  { id: 'qwen', args: ['--acp', '--experimental-skills'] },
];

describe('native ACP provider behaviors', () => {
  it.each(nativeAcpProviders)('$id declares ACP support', ({ id }) => {
    const provider = pluginRegistry.get(id);

    expect(provider).toBeDefined();
    expect(provider!.capabilities.acp.kind).toBe('supported');
    expect(provider!.behavior.acp).toBeDefined();
  });

  it.each(nativeAcpProviders)('$id starts the documented native ACP command', (entry) => {
    const provider = pluginRegistry.get(entry.id)!;
    const cli = entry.cli ?? spawnCtx.cli;
    const spawn = provider.behavior.acp!.buildSpawn({ ...spawnCtx, cli });

    expect(spawn.command).toBe(entry.command ?? cli);
    expect(spawn.args).toEqual(entry.args);

    if (entry.env) {
      expect(spawn.env).toEqual(entry.env);
    }
  });
});
