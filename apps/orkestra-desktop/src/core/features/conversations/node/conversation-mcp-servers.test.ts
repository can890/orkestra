import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMcpServerProvider } from '@core/services/agent-tools/api/agent-tools';
import { collectConversationMcpServers } from './conversation-mcp-servers';

const context = {
  conversationId: 'conversation-1',
  projectId: 'project-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  host: { type: 'local', id: 'local' } as const,
};

function provider(
  servers: () => Promise<{ name: string; command: string; args: string[] }[]>
): ConversationMcpServerProvider {
  return { conversationMcpServers: servers };
}

describe('collectConversationMcpServers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips reserved and duplicate names and failing providers', async () => {
    const warn = vi.fn();
    const servers = await collectConversationMcpServers({
      providers: [
        provider(async () => [
          { name: 'orkestra', command: 'x', args: [] },
          { name: 'orkestra-browser', command: 'a', args: [] },
        ]),
        provider(async () => {
          throw new Error('boom');
        }),
        provider(async () => [{ name: 'orkestra-browser', command: 'b', args: [] }]),
      ],
      context,
      logger: { ...noopLogger, warn },
      reserved: ['orkestra'],
    });
    expect(servers).toEqual([{ name: 'orkestra-browser', command: 'a', args: [] }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up on a provider that does not answer in time', async () => {
    vi.useFakeTimers();
    const pending = collectConversationMcpServers({
      providers: [provider(() => new Promise(() => undefined))],
      context,
      logger: noopLogger,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual([]);
  });
});
