import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
  execFile: mocks.execFile,
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getAppPath: () => '', getVersion: () => '0.0.0' } }));

vi.mock('@main/lib/childProcessEnv', () => ({
  buildExternalToolEnv: () => ({}),
}));

const { checkMacAppByName } = await import('./utils');

describe('checkMacAppByName', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orkestra-apps-'));
    mocks.exec.mockReset();
    mocks.execFile.mockReset();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('finds an app bundle in an application folder without running AppleScript', async () => {
    await mkdir(join(directory, 'Ghostty.app'));
    await expect(checkMacAppByName('Ghostty', [directory])).resolves.toBe(true);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('falls back to a non-interactive Spotlight lookup and never calls osascript', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) =>
        callback(null, '', '')
    );
    await expect(checkMacAppByName('Hyper', [directory])).resolves.toBe(false);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledWith(
      'mdfind',
      ['kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "Hyper.app"'],
      expect.anything(),
      expect.any(Function)
    );
    const commands = mocks.execFile.mock.calls.map((call) => String(call[0]));
    expect(commands).not.toContain('osascript');
  });
});
