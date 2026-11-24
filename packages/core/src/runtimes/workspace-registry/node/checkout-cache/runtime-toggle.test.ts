import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { workspaceRegistryStore } from '../persistence/store';
import { WorkspaceRegistryRuntime } from '../runtime';
import { WorktreeCheckoutCache } from './worktree-checkout-cache';

// Ayar kapatıldığında önbellek silinir; açıkken dokunulmaz.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('fast worktree checkout toggle', () => {
  it('deletes the cache when the host setting turns it off', async () => {
    const handle = await workspaceRegistryStore.openTemp();
    cleanups.push(() => handle.close());
    const root = await mkdtemp(join(dirname(handle.path), 'checkout-toggle-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cacheDir = join(root, 'worktree-checkout-cache');
    await mkdir(join(cacheDir, 'bucket'), { recursive: true });
    await writeFile(join(cacheDir, 'bucket', 'marker'), 'x');
    const cache = new WorktreeCheckoutCache({ cacheDir, cloner: async () => true });
    let enabled = true;
    const runtime = new WorkspaceRegistryRuntime({
      handle,
      attachments: new LocalAttachmentStore(join(root, 'attachments')),
      checkoutCache: { cache, enabled: async () => enabled },
    });
    cleanups.push(() => runtime.dispose());
    const clear = vi.spyOn(cache, 'clear');

    runtime.hostSettingsChanged();
    await vi.waitFor(async () => {
      await cache.whenIdle();
      expect(clear).not.toHaveBeenCalled();
    });
    await expect(stat(cacheDir)).resolves.toBeTruthy();

    enabled = false;
    runtime.hostSettingsChanged();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    await cache.whenIdle();
    await expect(stat(cacheDir)).rejects.toThrow();
  });
});
