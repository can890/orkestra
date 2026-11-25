import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recoverCodexMedia } from './codex-media';

it('recovers shortened media from tool outputs of the same session, including replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-media-'));
  try {
    const sessionId = '01a21494-8d1f-7b53-bf69-fc23f3205767';
    const dir = join(home, 'sessions', '2026', '11', '25');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'rollout-test-' + sessionId + '.jsonl');
    const head = 'A'.repeat(80),
      tail = 'B'.repeat(80);
    const body = head + 'AAAA' + tail;
    const entries = ['image/jpeg', 'video/mp4', 'application/pdf'].map((type, i) => ({
      [['image_url', 'video_url', 'file_data'][i]!]: 'data:' + type + ';base64,' + body,
    }));
    const row = {
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: entries },
    };
    await writeFile(file, JSON.stringify(row) + '\n');
    const original = JSON.stringify({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec-id',
          rawOutput: { output: entries },
        },
      },
    });
    const clipped = original.replaceAll(body, head + '…4 chars truncated…' + tail);
    expect(await recoverCodexMedia(clipped, home)).toBe(original);
    await writeFile(
      file,
      JSON.stringify({ ...row, payload: { type: 'message', output: entries } })
    );
    expect(await recoverCodexMedia(clipped, home)).toBe(clipped);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
