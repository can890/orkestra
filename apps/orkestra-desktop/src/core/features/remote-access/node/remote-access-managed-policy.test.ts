import { createController, type Controller } from '@orkestra/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveManagedPolicy } from '@core/primitives/managed-policy/api/node/active-policy';
import { activateManagedPolicyForTest } from '@core/primitives/managed-policy/api/node/testing';
import { RemoteAccessService, type StoredRemoteAccessState } from './remote-access-service';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function setup(enabledAtBoot: boolean) {
  let persisted: StoredRemoteAccessState | null = enabledAtBoot
    ? { version: 1, hostId: 'host-aaaa-bbbb', enabled: true, port: 50123, devices: [] }
    : null;
  const listen = vi.fn(async (_server: unknown, options: { port: number }) => ({
    port: options.port || 50999,
    close: async () => {},
  }));
  const service = new RemoteAccessService({
    persistence: {
      load: async () => (persisted ? structuredClone(persisted) : null),
      save: async (state) => {
        persisted = structuredClone(state);
      },
    },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} } as never,
    logger: noopLogger,
    hostName: () => 'Host',
    networkInterfaces: () => ({}),
    isSecureStorageAvailable: () => true,
    listen: listen as never,
    now: () => 1,
    pickPort: () => 50123,
  });
  const controllers: Record<string, Controller> = {
    noop: createController({} as never, {} as never),
  };
  return { service, listen, controllers };
}

afterEach(() => setActiveManagedPolicy(undefined));

describe('remote access under a managed policy', () => {
  it('does not listen at boot and refuses to enable when remote access is off', async () => {
    activateManagedPolicyForTest({ limits: { remoteAccess: false } });
    const ctx = setup(true);
    await ctx.service.start(ctx.controllers);
    expect(ctx.listen).not.toHaveBeenCalled();
    expect(await ctx.service.setEnabled(true)).toMatchObject({
      success: false,
      error: { type: 'failed', message: expect.stringMatching(/Example Corp's policy/) },
    });
    // Kapatmak her zaman serbesttir.
    expect((await ctx.service.setEnabled(false)).success).toBe(true);
  });

  it('refuses new pairings when device pairing is off', async () => {
    activateManagedPolicyForTest({ limits: { devicePairing: false } });
    const ctx = setup(false);
    await ctx.service.start(ctx.controllers);
    expect((await ctx.service.setEnabled(true)).success).toBe(true);
    expect(await ctx.service.createPairing()).toMatchObject({
      success: false,
      error: { message: expect.stringMatching(/pairing new devices/) },
    });
  });

  it('behaves as before without a policy', async () => {
    const ctx = setup(true);
    await ctx.service.start(ctx.controllers);
    expect(ctx.listen).toHaveBeenCalledTimes(1);
  });
});
