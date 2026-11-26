/**
 * MacModifierPairWatcher — Zero-native-addon macOS double-tap modifier watcher
 * (Shift+Shift, Option+Option, Command+Command) via `/usr/bin/osascript -l JavaScript`
 * using `CGEventSourceFlagsState` with `NSApplicationActivationPolicyProhibited` (no Dock icon).
 *
 * Adapted from T3 Code (MIT License) MacModifierPairShortcutProcess.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type ModifierPairKey = 'shift' | 'option' | 'command';

const MODIFIER_MASKS: Record<ModifierPairKey, number> = {
  shift: 0x00020000, // kCGEventFlagMaskShift
  option: 0x00080000, // kCGEventFlagMaskAlternate
  command: 0x00100000, // kCGEventFlagMaskCommand
};

export function parseModifierPairShortcut(shortcut: string): ModifierPairKey | null {
  const normalized = shortcut.trim().toLowerCase().replace(/\s+/g, '');
  if (normalized === 'shift+shift' || normalized === 'doubleshift') return 'shift';
  if (normalized === 'option+option' || normalized === 'alt+alt') return 'option';
  if (
    normalized === 'command+command' ||
    normalized === 'cmd+cmd' ||
    normalized === 'commandorcontrol+commandorcontrol'
  ) {
    return 'command';
  }
  return null;
}

function buildJxaScript(mask: number): string {
  return `
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
const TARGET = ${mask};
const OTHER_MASK = (0x00020000 | 0x00080000 | 0x00100000 | 0x00040000) ^ TARGET;
let wasDown = false;
let lastReleaseAt = 0;
let downAt = 0;
let dirty = false;
while (true) {
  const flags = $.CGEventSourceFlagsState($.kCGEventSourceStateCombinedSessionState);
  const isDown = (flags & TARGET) !== 0;
  const otherDown = (flags & OTHER_MASK) !== 0;
  const now = Date.now();
  if (otherDown) dirty = true;
  if (isDown && !wasDown) {
    downAt = now;
    dirty = otherDown;
  } else if (!isDown && wasDown) {
    const heldMs = now - downAt;
    if (!dirty && heldMs <= 320) {
      if (now - lastReleaseAt <= 380) {
        ObjC.import('Foundation');
        const out = $.NSFileHandle.fileHandleWithStandardOutput;
        out.writeData($('TRIGGER\\n').dataUsingEncoding($.NSUTF8StringEncoding));
        lastReleaseAt = 0;
      } else {
        lastReleaseAt = now;
      }
    } else {
      lastReleaseAt = 0;
    }
  }
  wasDown = isDown;
  delay(0.025);
}
`.trim();
}

export class MacModifierPairWatcher {
  private proc: ChildProcess | null = null;
  private buffer = '';

  start(key: ModifierPairKey, onTrigger: () => void): boolean {
    this.stop();
    if (process.platform !== 'darwin') return false;
    try {
      const proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', buildJxaScript(MODIFIER_MASKS[key])], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.proc = proc;
      proc.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === 'TRIGGER') onTrigger();
        }
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
      });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.buffer = '';
  }
}
