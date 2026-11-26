/**
 * macOS Accessibility Tree snapshot helper (3s hard timeout race).
 * Adapted from T3 Code (MIT License) SnapShotAccessibility.ts.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AX_CAPTURE_SCRIPT = `
ObjC.import('Foundation');
const se = Application('System Events');
const front = se.applicationProcesses.whose({ frontmost: true })[0];
if (!front) '';
else {
  const lines = [];
  const MAX_NODES = 80;
  function walk(el, depth) {
    if (lines.length >= MAX_NODES || depth > 5) return;
    try {
      const role = String(el.role() || '').replace(/^AX/, '');
      let title = '';
      try { title = String(el.title() || ''); } catch {}
      let desc = '';
      try { desc = String(el.description() || ''); } catch {}
      let val = '';
      try {
        const raw = el.value();
        if (typeof raw === 'string') val = raw;
      } catch {}
      const label = (title || desc || val).replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (label && role) {
        lines.push('  '.repeat(depth) + role + ': ' + label);
      }
      const children = el.uiElements();
      const limit = Math.min(children.length, 24);
      for (let i = 0; i < limit && lines.length < MAX_NODES; i++) {
        walk(children[i], depth + 1);
      }
    } catch {}
  }
  try {
    const win = front.windows[0];
    if (win) walk(win, 0);
  } catch {}
  lines.join('\\n');
}
`.trim();

/**
 * Captures a compact macOS Accessibility Tree summary for the frontmost window.
 * Strictly capped at 3 seconds so it can never block or delay SnapShot capture.
 */
export async function captureFrontmostAccessibilityTree(
  timeoutMs = 3_000
): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', AX_CAPTURE_SCRIPT],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 3_500 ? `${trimmed.slice(0, 3_500)}\n…` : trimmed;
  } catch {
    return undefined;
  }
}
