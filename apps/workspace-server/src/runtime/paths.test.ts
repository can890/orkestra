import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceServerRuntimePaths } from './paths';

describe('workspaceServerRuntimePaths', () => {
  it('places state beside a custom socket instead of in its parent directory', () => {
    const paths = workspaceServerRuntimePaths('/tmp/orkestra-test/workspace.sock');

    expect(paths.rootDirectory).toBe('/tmp/orkestra-test');
    expect(paths.stateDirectory).toBe('/tmp/orkestra-test/state');
  });

  it('keeps the conventional run and state directories as siblings', () => {
    const root = join('/tmp', 'orkestra-test');
    const paths = workspaceServerRuntimePaths(join(root, 'run', 'workspace.sock'));

    expect(paths.rootDirectory).toBe(root);
    expect(paths.stateDirectory).toBe(join(root, 'state'));
  });
});
