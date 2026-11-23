import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '@orkestra/core/services/agent-plugins/api/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

const baseContext: CommandContext = {
  cli: 'agy',
  autoApprove: false,
  sessionId: 'orkestra-conversation-id',
  isResuming: false,
  model: '',
};

describe('antigravity provider', () => {
  it('starts fresh with the initial prompt without passing the orkestra conversation id', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      initialPrompt: 'Fix the bug',
    });

    expect(command).toEqual({
      command: 'agy',
      args: ['-i', 'Fix the bug'],
      env: {},
    });
  });

  it('resumes the captured native conversation id without replaying the initial prompt', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      providerSessionId: 'native-conversation-id',
      isResuming: true,
      initialPrompt: 'Do not replay this',
    });

    expect(command.args).toEqual(['--conversation=native-conversation-id']);
  });

  it('uses the continue fallback when asked to resume without a native conversation id', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      isResuming: true,
      initialPrompt: 'Do not replay this',
    });

    expect(command.args).toEqual(['-c']);
  });

  it('resolves the native agy conversation id from an ACP bridge state file when switching to terminal', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'orkestra-agy-state-'));
    try {
      const bridgeId = '11111111-1111-4111-8111-111111111111';
      const nativeId = '22222222-2222-4222-8222-222222222222';
      writeFileSync(
        join(stateDir, `${bridgeId}.json`),
        JSON.stringify({ cwd: '/tmp', model: 'gemini-4-neon-high', mode: 'default', nativeId })
      );
      const command = provider.behavior.prompt!.buildCommand({
        ...baseContext,
        providerSessionId: bridgeId,
        isResuming: true,
        env: { ORKESTRA_AGY_STATE_DIR: stateDir },
      });
      expect(command.args).toEqual([`--conversation=${nativeId}`]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('starts a clean terminal session when switching an unprompted ACP bridge session', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'orkestra-agy-state-'));
    try {
      const bridgeId = '33333333-3333-4333-8333-333333333333';
      writeFileSync(
        join(stateDir, `${bridgeId}.json`),
        JSON.stringify({ cwd: '/tmp', model: 'gemini-4-neon-high', mode: 'default' })
      );
      const command = provider.behavior.prompt!.buildCommand({
        ...baseContext,
        providerSessionId: bridgeId,
        isResuming: true,
        env: { ORKESTRA_AGY_STATE_DIR: stateDir },
      });
      expect(command.args).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('applies configured default Orchestrator mode and planner/executor settings in terminal launches', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      initialPrompt: 'Projeyi planla',
      env: {
        ORKESTRA_AGY_ORCHESTRATOR_MODE: 'gemini-pro-orchestrator-neon',
        ORKESTRA_AGY_ORCHESTRATOR_PLANNER: 'gemini-4-neon-xhigh',
        ORKESTRA_AGY_ORCHESTRATOR_EXECUTOR: 'gemini-4-hydrogen-high',
      },
    });

    expect(command.args).toEqual([
      '--settings',
      JSON.stringify({
        orchestrator: {
          planner: 'gemini-4-neon-xhigh',
          executor: 'gemini-4-hydrogen-high',
        },
      }),
      '--model',
      'gemini-pro-orchestrator-neon',
      '-i',
      'Projeyi planla',
    ]);
  });

  it('keeps an explicit model choice while still forwarding orchestrator role settings', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      model: 'gemini-pro-orchestrator',
      env: {
        ORKESTRA_AGY_ORCHESTRATOR_MODE: 'gemini-pro-orchestrator-neon',
        ORKESTRA_AGY_ORCHESTRATOR_PLANNER: 'claude-opus-5-5-high',
      },
    });

    expect(command.args).toEqual([
      '--settings',
      JSON.stringify({ orchestrator: { planner: 'claude-opus-5-5-high' } }),
      '--model',
      'gemini-pro-orchestrator',
    ]);
  });
});
