import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import { activateManagedPolicyForTest } from '@core/primitives/managed-policy/api/node/testing';
import { OutsideAgentsService } from './outside-agents-service';
import { FakeBackend, MemoryPersistence, MemorySecretStore } from './testing/fakes';

let service: OutsideAgentsService | null = null;

afterEach(async () => {
  setActiveManagedPolicy(undefined);
  await service?.dispose();
  service = null;
});

describe('outside-agent MCP server under a managed policy', () => {
  it('refuses to turn on and never listens when the policy turns it off', async () => {
    activateManagedPolicyForTest({ limits: { outsideAgents: false } });
    service = new OutsideAgentsService({
      persistence: new MemoryPersistence(),
      secrets: new MemorySecretStore(),
      logger: noopLogger,
      isSecureStorageAvailable: () => true,
      serverVersion: '0.0.0-test',
      createBackend: () => new FakeBackend(),
      serverOverrides: { port: 0, sleep: async () => {} },
    });
    await service.start({});
    expect(await service.configure({ enabled: true })).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/outside-agent MCP server/) },
    });
    expect((await service.getStatus()).listening).toBe(false);
  });
});
