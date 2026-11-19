import {
  chunkText,
  COMPUTER_INPUT_JXA,
  ComputerToolError,
  type DisplayInfo,
  type InputRequest,
} from './computer-input';

export type ProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
};

/**
 * Süreç çalıştırıcı: her zaman argv dizisiyle ve kabuksuz çalışır. Testlerde sahte bir çalıştırıcı
 * verilir; gerçek fare/klavye olayı ya da ekran görüntüsü yalnızca üretimdeki çalıştırıcıyla olur.
 */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number }
) => Promise<ProcessResult>;

export type ScratchFile = {
  path: string;
  read(): Promise<Buffer>;
  dispose(): Promise<void>;
};

/** Ekran görüntüsü için geçici dosya (0700 dizin içinde). */
export type ScratchFiles = { create(extension: string): Promise<ScratchFile> };

export type ScreenshotResult = {
  data: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
};

const INPUT_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * macOS masaüstünü `screencapture` (ekran görüntüsü), `sips` (yeniden boyutlandırma) ve
 * `osascript` + sabit JXA betiği (CGEvent girdisi) ile kullanır. Yeni native bağımlılık yoktur.
 */
export class ComputerDesktop {
  private display: DisplayInfo | null = null;

  constructor(private readonly deps: { run: ProcessRunner; scratch: ScratchFiles }) {}

  /** Ana ekranın nokta cinsinden boyutu (fare koordinatları ve ekran görüntüsü aynı ölçekte). */
  async displayInfo(): Promise<DisplayInfo> {
    // Ekran değişmiş olabilir; her araç çağrısında yeniden okunur (ucuz ve olay göndermez).
    const reply = await this.input({ action: 'info' });
    const width = Number(reply.width);
    const height = Number(reply.height);
    const scale = Number(reply.scale);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new ComputerToolError('Could not read the screen size.');
    }
    this.display = {
      width: Math.floor(width),
      height: Math.floor(height),
      scale: scale >= 1 ? scale : 1,
    };
    return this.display;
  }

  async screenshot(): Promise<ScreenshotResult> {
    const display = await this.displayInfo();
    const file = await this.deps.scratch.create('jpg');
    try {
      const capture = await this.deps.run('screencapture', ['-x', '-m', '-t', 'jpg', file.path], {
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      if (capture.exitCode !== 0) {
        throw new ComputerToolError(
          `screencapture failed${capture.timedOut ? ' (timed out)' : ''}: ${capture.stderr.trim().slice(0, 300)}`
        );
      }
      if (display.scale > 1) {
        // Piksel = nokta olsun ki ajanın okuduğu koordinatlar doğrudan fare koordinatı olsun.
        const resize = await this.deps.run(
          'sips',
          ['--resampleWidth', String(display.width), file.path],
          { timeoutMs: CAPTURE_TIMEOUT_MS }
        );
        if (resize.exitCode !== 0) {
          throw new ComputerToolError(`sips failed: ${resize.stderr.trim().slice(0, 300)}`);
        }
      }
      const image = await file.read();
      if (image.length === 0) throw new ComputerToolError('The screenshot is empty.');
      return {
        data: image.toString('base64'),
        mimeType: 'image/jpeg',
        width: display.width,
        height: display.height,
      };
    } finally {
      await file.dispose().catch(() => undefined);
    }
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.input({ action: 'move', x, y });
  }

  async click(x: number, y: number, button: 'left' | 'right', clicks: 1 | 2): Promise<void> {
    await this.input({ action: 'click', x, y, button, clicks });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.input({ action: 'drag', fromX, fromY, toX, toY });
  }

  /**
   * Metni parçalar halinde yazar; her parçadan önce `shouldContinue` sorulur, böylece "Durdur"
   * uzun bir yazma sırasında da etkili olur.
   */
  async typeText(text: string, shouldContinue: () => Promise<boolean>): Promise<void> {
    for (const chunk of chunkText(text)) {
      if (!(await shouldContinue()))
        throw new ComputerToolError('Computer use was stopped by the user.');
      await this.input({ action: 'type', text: chunk });
    }
  }

  async pressKey(keyCode: number, flags: number): Promise<void> {
    await this.input({ action: 'key', keyCode, flags });
  }

  private async input(request: InputRequest): Promise<Record<string, unknown>> {
    const result = await this.deps.run(
      'osascript',
      ['-l', 'JavaScript', '-e', COMPUTER_INPUT_JXA],
      { stdin: JSON.stringify(request), timeoutMs: INPUT_TIMEOUT_MS }
    );
    if (result.exitCode !== 0) {
      throw new ComputerToolError(
        `osascript failed${result.timedOut ? ' (timed out)' : ''}: ${result.stderr.trim().slice(0, 300)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString('utf8').trim());
    } catch {
      throw new ComputerToolError('osascript returned an unreadable reply.');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ComputerToolError('osascript returned an unreadable reply.');
    }
    const reply = parsed as Record<string, unknown>;
    if (reply.ok !== true) {
      throw new ComputerToolError(
        `Desktop input failed: ${typeof reply.error === 'string' ? reply.error.slice(0, 300) : 'unknown error'}`
      );
    }
    return reply;
  }
}
