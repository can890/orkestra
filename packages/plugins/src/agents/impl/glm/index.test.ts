import type { CommandContext } from '@orkestra/core/services/agent-plugins/api/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

const baseContext: CommandContext = {
  cli: '/usr/local/bin/claude',
  autoApprove: false,
  sessionId: 'conv-uuid-1',
  isResuming: false,
  model: '',
  env: {
    HOME: '/Users/tester',
    ZAI_API_KEY: 'zai-secret-key',
  },
};

describe('glm provider', () => {
  it('supports ACP, resumable sessions, prompt delivery, hooks, and trust', () => {
    expect(provider.capabilities.acp).toEqual({ kind: 'supported' });
    expect(provider.capabilities.sessions).toEqual({ kind: 'resumable' });
    expect(provider.capabilities.prompt).toEqual({ kind: 'argv', flag: '' });
    expect(provider.capabilities.hooks.kind).toBe('config');
    expect(provider.capabilities.trust).toEqual({ kind: 'supported' });
  });

  it('builds a fresh terminal command with isolated GLM config dir and Z.ai env', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      model: 'glm-5.3-flash',
      autoApprove: true,
      initialPrompt: 'Testleri çalıştır',
    });

    expect(command.command).toBe('/usr/local/bin/claude');
    expect(command.args).toEqual([
      '--session-id',
      'conv-uuid-1',
      '--dangerously-skip-permissions',
      '--model',
      'haiku',
      'Testleri çalıştır',
    ]);
    expect(command.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/Users/tester/.orkestra/glm-claude',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
    });
  });

  it('resumes an ACP session id in terminal with --resume and maps glm-5.3 to sonnet', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      isResuming: true,
      providerSessionId: 'acp-session-42',
      model: 'glm-5.3',
    });

    expect(command.args).toEqual(['--resume', 'acp-session-42', '--model', 'sonnet']);
  });

  it('throws a clear Turkish error when ZAI_API_KEY is missing', () => {
    expect(() =>
      provider.behavior.prompt!.buildCommand({
        ...baseContext,
        env: { HOME: '/Users/tester' },
      })
    ).toThrow(/ZAI_API_KEY/);
  });
});
