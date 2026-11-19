import { describe, expect, it } from 'vitest';
import { ComputerDesktop, type ProcessRunner, type ScratchFiles } from './computer-desktop';
import { COMPUTER_INPUT_JXA, ComputerToolError } from './computer-input';

type Call = { command: string; args: readonly string[]; stdin: string | undefined };

/** Sahte çalıştırıcı: hiçbir gerçek süreç başlatmaz, ekran görüntüsü almaz, olay göndermez. */
function fakeRunner(options: { scale?: number; failOn?: string } = {}) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, opts) => {
    calls.push({ command, args, stdin: opts.stdin });
    if (command === options.failOn) {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: 'denied', timedOut: false };
    }
    if (command === 'osascript') {
      const request = JSON.parse(opts.stdin ?? '{}') as { action: string };
      const body =
        request.action === 'info'
          ? { ok: true, width: 1470, height: 956, scale: options.scale ?? 2 }
          : { ok: true };
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(body)),
        stderr: '',
        timedOut: false,
      };
    }
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false };
  };
  return { calls, run };
}

function fakeScratch() {
  const created: string[] = [];
  const disposed: string[] = [];
  const scratch: ScratchFiles = {
    async create(extension) {
      const path = `/scratch/capture.${extension}`;
      created.push(path);
      return {
        path,
        read: async () => Buffer.from('jpeg-bytes'),
        dispose: async () => {
          disposed.push(path);
        },
      };
    },
  };
  return { scratch, created, disposed };
}

const HOSTILE = 'a"b\'c\\d\n$(touch /tmp/pwned) `id` ; rm -rf ~ çğ';

describe('ComputerDesktop input', () => {
  it('runs the fixed JXA through osascript argv and passes values only on stdin', async () => {
    const { calls, run } = fakeRunner();
    const desktop = new ComputerDesktop({ run, scratch: fakeScratch().scratch });
    await desktop.typeText(HOSTILE, async () => true);
    await desktop.click(10, 20, 'right', 1);
    await desktop.drag(1, 2, 3, 4);
    await desktop.moveMouse(5, 6);
    await desktop.pressKey(8, 0x100000);

    expect(calls.length).toBe(5);
    for (const call of calls) {
      expect(call.command).toBe('osascript');
      expect(call.args).toEqual(['-l', 'JavaScript', '-e', COMPUTER_INPUT_JXA]);
      // Hiçbir argv öğesi (betik dahil) kullanıcı metnini içermez.
      for (const arg of call.args) expect(arg).not.toContain('touch /tmp/pwned');
    }
    expect(calls.map((call) => JSON.parse(call.stdin ?? '{}'))).toEqual([
      { action: 'type', text: HOSTILE },
      { action: 'click', x: 10, y: 20, button: 'right', clicks: 1 },
      { action: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 },
      { action: 'move', x: 5, y: 6 },
      { action: 'key', keyCode: 8, flags: 0x100000 },
    ]);
  });

  it('keeps the script source identical for every call', async () => {
    const { calls, run } = fakeRunner();
    const desktop = new ComputerDesktop({ run, scratch: fakeScratch().scratch });
    await desktop.typeText('one', async () => true);
    await desktop.typeText(HOSTILE, async () => true);
    const sources = new Set(calls.map((call) => call.args[3]));
    expect(sources.size).toBe(1);
  });

  it('types long text in chunks and stops between chunks when asked', async () => {
    const { calls, run } = fakeRunner();
    const desktop = new ComputerDesktop({ run, scratch: fakeScratch().scratch });
    await desktop.typeText('x'.repeat(200), async () => true);
    expect(calls).toHaveLength(3);

    calls.length = 0;
    let allowed = 1;
    await expect(desktop.typeText('x'.repeat(200), async () => allowed-- > 0)).rejects.toThrow(
      /stopped/
    );
    expect(calls).toHaveLength(1);
  });

  it('surfaces osascript failures and unreadable replies as tool errors', async () => {
    const failing = fakeRunner({ failOn: 'osascript' });
    const desktop = new ComputerDesktop({ run: failing.run, scratch: fakeScratch().scratch });
    await expect(desktop.moveMouse(1, 1)).rejects.toBeInstanceOf(ComputerToolError);

    const garbled: ProcessRunner = async () => ({
      exitCode: 0,
      stdout: Buffer.from('not json'),
      stderr: '',
      timedOut: false,
    });
    await expect(
      new ComputerDesktop({ run: garbled, scratch: fakeScratch().scratch }).moveMouse(1, 1)
    ).rejects.toThrow(/unreadable/);
  });
});

describe('ComputerDesktop screenshot', () => {
  it('captures the main display with screencapture argv and downsizes Retina captures', async () => {
    const { calls, run } = fakeRunner({ scale: 2 });
    const files = fakeScratch();
    const shot = await new ComputerDesktop({ run, scratch: files.scratch }).screenshot();

    const capture = calls.find((call) => call.command === 'screencapture');
    expect(capture?.args).toEqual(['-x', '-m', '-t', 'jpg', '/scratch/capture.jpg']);
    const resize = calls.find((call) => call.command === 'sips');
    expect(resize?.args).toEqual(['--resampleWidth', '1470', '/scratch/capture.jpg']);
    expect(shot).toEqual({
      data: Buffer.from('jpeg-bytes').toString('base64'),
      mimeType: 'image/jpeg',
      width: 1470,
      height: 956,
    });
    expect(files.disposed).toEqual(files.created);
  });

  it('skips resizing at scale 1 and always removes the scratch file', async () => {
    const { calls, run } = fakeRunner({ scale: 1 });
    await new ComputerDesktop({ run, scratch: fakeScratch().scratch }).screenshot();
    expect(calls.some((call) => call.command === 'sips')).toBe(false);

    const failing = fakeRunner({ failOn: 'screencapture' });
    const files = fakeScratch();
    await expect(
      new ComputerDesktop({ run: failing.run, scratch: files.scratch }).screenshot()
    ).rejects.toThrow(/screencapture failed/);
    expect(files.disposed).toEqual(files.created);
  });
});
