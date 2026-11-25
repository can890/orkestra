import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackgroundTaskWatcher,
  notificationTextFromTranscriptLine,
  parseTaskNotificationText,
  type BackgroundTaskUpdateEvent,
} from './background-task-watcher';

const SESSION = '3b64607d-d203-4696-9efb-06a6424f89bf';
const SLUG = '-Users-test-project';

type Layout = {
  root: string;
  sessionFile: string;
  outputFile: (agentId: string) => Promise<string>;
};

const roots: string[] = [];

/** Claude Code'un diskteki düzenini kurar: oturum kaydı, alt ajan kaydı ve geçici dizindeki bağ. */
async function makeLayout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-bg-task-'));
  roots.push(root);
  const projectDir = join(root, 'claude', 'projects', SLUG);
  const subagentsDir = join(projectDir, SESSION, 'subagents');
  const tasksDir = join(root, 'tmp', 'claude-501', SLUG, SESSION, 'tasks');
  await mkdir(subagentsDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
  return {
    root,
    sessionFile,
    outputFile: async (agentId) => {
      const transcript = join(subagentsDir, `agent-${agentId}.jsonl`);
      await writeFile(transcript, '');
      const link = join(tasksDir, `${agentId}.output`);
      await symlink(transcript, link);
      return link;
    },
  };
}

function notification(input: {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary?: string;
  result?: string;
  note?: string;
}): string {
  return [
    '<task-notification>',
    `<task-id>${input.taskId}</task-id>`,
    ...(input.toolUseId ? [`<tool-use-id>${input.toolUseId}</tool-use-id>`] : []),
    `<status>${input.status}</status>`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    ...(input.note ? [`<note>${input.note}</note>`] : []),
    ...(input.result ? [`<result>${input.result}</result>`] : []),
    '</task-notification>',
  ].join('\n');
}

function enqueueLine(content: string): string {
  return `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, content })}\n`;
}

function makeWatcher(root: string) {
  const updates: BackgroundTaskUpdateEvent[] = [];
  const watcher = new BackgroundTaskWatcher({
    onUpdate: (event) => updates.push(event),
    intervalMs: 60_000,
    claudeConfigDir: join(root, 'claude'),
  });
  return { watcher, updates };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('parseTaskNotificationText', () => {
  it('reads the id, status, summary and result even behind a preamble', () => {
    const text = `[SYSTEM NOTIFICATION]\n${notification({
      taskId: 'a1',
      toolUseId: 'toolu_1',
      status: 'completed',
      summary: 'Agent "x" finished',
      result: 'Rapor\nikinci satır',
    })}`;
    expect(parseTaskNotificationText(text)).toEqual({
      taskId: 'a1',
      toolUseId: 'toolu_1',
      status: 'completed',
      summary: 'Agent "x" finished',
      result: 'Rapor\nikinci satır',
    });
  });

  it('flags a notification from an agent that is still waiting on its own background work', () => {
    const parsed = parseTaskNotificationText(
      notification({
        taskId: 'a1',
        status: 'completed',
        note: 'This agent stopped with background work of its own still running. It may resume.',
      })
    );
    expect(parsed?.interim).toBe(true);
  });

  it('returns null without a task id or status', () => {
    expect(parseTaskNotificationText('<task-notification><status>completed</status>')).toBeNull();
    expect(parseTaskNotificationText('plain text')).toBeNull();
  });
});

describe('notificationTextFromTranscriptLine', () => {
  it('accepts enqueue records and notification user messages only', () => {
    const body = notification({ taskId: 'a1', status: 'completed' });
    expect(notificationTextFromTranscriptLine(enqueueLine(body).trim())).toBe(body);
    expect(
      notificationTextFromTranscriptLine(
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: body }] } })
      )
    ).toBe(body);
    expect(
      notificationTextFromTranscriptLine(
        JSON.stringify({ type: 'queue-operation', operation: 'remove', content: body })
      )
    ).toBeNull();
    // İstek dökümleri de aynı metni içerir; bunlar bildirim sayılmamalı.
    expect(
      notificationTextFromTranscriptLine(
        JSON.stringify({ type: 'api-request-blob', message: { content: body } })
      )
    ).toBeNull();
    expect(notificationTextFromTranscriptLine('{not json <task-notification>')).toBeNull();
  });
});

describe('BackgroundTaskWatcher', () => {
  it('completes a registered agent when its notification is appended to the session transcript', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({
      agentId: 'a505',
      toolCallId: 'toolu_a',
      outputFile: await layout.outputFile('a505'),
    });
    await watcher.poll();
    expect(updates).toEqual([]);
    expect(watcher.activeCount).toBe(1);

    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({
          taskId: 'a505',
          toolUseId: 'toolu_a',
          status: 'completed',
          summary: 'Agent "Lane" finished',
          result: 'Bitti: 30/30 test geçti.',
        })
      )
    );
    await watcher.poll();

    expect(updates).toEqual([
      {
        kind: 'subagent_update',
        agentId: 'a505',
        toolCallId: 'toolu_a',
        status: 'completed',
        summary: 'Bitti: 30/30 test geçti.',
      },
    ]);
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('finds a notification that was written before the agent was registered (app restart)', async () => {
    const layout = await makeLayout();
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'a777', status: 'completed', result: 'eski yanıt' }))
    );
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({
      agentId: 'a777',
      toolCallId: 'toolu_old',
      outputFile: await layout.outputFile('a777'),
    });
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.status, u.summary])).toEqual([
      ['a777', 'completed', 'eski yanıt'],
    ]);
    watcher.dispose();
  });

  it('maps killed and failed tasks to failed and ignores other agents', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({
      agentId: 'k1',
      toolCallId: 't1',
      outputFile: await layout.outputFile('k1'),
    });
    watcher.register({
      agentId: 'f1',
      toolCallId: 't2',
      outputFile: await layout.outputFile('f1'),
    });
    watcher.register({
      agentId: 'r1',
      toolCallId: 't3',
      outputFile: await layout.outputFile('r1'),
    });
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'k1', status: 'killed', summary: 'Task was stopped' })) +
        enqueueLine(notification({ taskId: 'f1', status: 'failed', summary: 'boom' })) +
        enqueueLine(notification({ taskId: 'someone-else', status: 'completed' })) +
        enqueueLine(notification({ taskId: 'r1', status: 'running' }))
    );
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.status, u.summary])).toEqual([
      ['k1', 'failed', 'Alt ajan durduruldu.'],
      ['f1', 'failed', 'boom'],
    ]);
    expect(watcher.activeCount).toBe(1);
    watcher.dispose();
  });

  it('matches by tool call id when the task id differs', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({
      agentId: 'a9',
      toolCallId: 'toolu_x',
      outputFile: await layout.outputFile('a9'),
    });
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'other-id', toolUseId: 'toolu_x', status: 'completed' }))
    );
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.toolCallId, u.status])).toEqual([
      ['a9', 'toolu_x', 'completed'],
    ]);
    watcher.dispose();
  });

  it('keeps following an agent after an interim notification and applies the final result', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({ agentId: 'w1', toolCallId: 't', outputFile: await layout.outputFile('w1') });
    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({
          taskId: 'w1',
          status: 'completed',
          note: 'This agent stopped with background work of its own still running.',
          result: 'bekliyorum',
        })
      )
    );
    await watcher.poll();
    expect(watcher.activeCount).toBe(1);
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'w1', status: 'completed', result: 'asıl rapor' }))
    );
    await watcher.poll();
    expect(updates.map((u) => u.summary)).toEqual(['bekliyorum', 'asıl rapor']);
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('handles a notification split across two writes and multi-byte text', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({ agentId: 's1', toolCallId: 't', outputFile: await layout.outputFile('s1') });
    const line = enqueueLine(
      notification({ taskId: 's1', status: 'completed', result: 'çalışıyor görünmesin 🚀' })
    );
    const bytes = Buffer.from(line, 'utf8');
    const cut = bytes.indexOf(Buffer.from('🚀', 'utf8')) + 2; // çok baytlı karakterin ortası
    await appendFile(layout.sessionFile, bytes.subarray(0, cut));
    await watcher.poll();
    expect(updates).toEqual([]);
    await appendFile(layout.sessionFile, bytes.subarray(cut));
    await watcher.poll();
    expect(updates.map((u) => u.summary)).toEqual(['çalışıyor görünmesin 🚀']);
    watcher.dispose();
  });

  it('falls back to the Claude projects dir when the output link cannot be resolved', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    // Bağ yok: yalnızca yol biçiminden (slug + oturum kimliği) oturum kaydı bulunur.
    const missingLink = join(layout.root, 'tmp', 'claude-501', SLUG, SESSION, 'tasks', 'm1.output');
    watcher.register({ agentId: 'm1', toolCallId: 't', outputFile: missingLink });
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'm1', status: 'completed', result: 'tamam' }))
    );
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.summary])).toEqual([['m1', 'tamam']]);
    watcher.dispose();
  });

  it('follows an agent known only by its tool call and session id (launch reply never seen)', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    // Çıktı dosyası ve görev kimliği yok: oturum kaydı proje dizinleri taranarak bulunur.
    watcher.register({ toolCallId: 'toolu_live', sessionId: SESSION });
    await watcher.poll();
    expect(watcher.activeCount).toBe(1);
    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({
          taskId: 'af343b36',
          toolUseId: 'toolu_live',
          status: 'completed',
          result: 'APK kuruldu',
        })
      )
    );
    await watcher.poll();
    expect(updates).toEqual([
      {
        kind: 'subagent_update',
        agentId: 'af343b36',
        toolCallId: 'toolu_live',
        status: 'completed',
        summary: 'APK kuruldu',
      },
    ]);
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('remembers the task id from the first notification for later ones without a tool use id', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({ toolCallId: 'toolu_w', sessionId: SESSION });
    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({
          taskId: 'task-w',
          toolUseId: 'toolu_w',
          status: 'completed',
          note: 'This agent stopped with background work of its own still running.',
          result: 'ara',
        })
      ) + enqueueLine(notification({ taskId: 'task-w', status: 'completed', result: 'son' }))
    );
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.toolCallId, u.summary])).toEqual([
      ['task-w', 'toolu_w', 'ara'],
      ['task-w', 'toolu_w', 'son'],
    ]);
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('rescans the transcript for an agent registered after the cursor passed its notification', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'old-b', toolUseId: 'toolu_b', status: 'completed' }))
    );
    // İlk ajan dosyanın tamamını okutur; imleç ikinci ajanın bildirimini geçer.
    watcher.register({ toolCallId: 'toolu_a', sessionId: SESSION });
    await watcher.poll();
    expect(updates).toEqual([]);
    watcher.register({ toolCallId: 'toolu_b', sessionId: SESSION });
    await watcher.poll();
    expect(updates.map((u) => [u.toolCallId, u.status])).toEqual([['toolu_b', 'completed']]);
    expect(watcher.activeCount).toBe(1);
    watcher.dispose();
  });

  it('ignores a session id that could escape the projects directory', async () => {
    const layout = await makeLayout();
    const { watcher } = makeWatcher(layout.root);
    watcher.register({ toolCallId: 'toolu_evil', sessionId: '../../etc/passwd' });
    for (let i = 0; i < 40; i += 1) await watcher.poll();
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('closes a resumed agent only with the notification of the resuming call', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    // Ajanın ilk bitişi oturum kaydında zaten var (sırada tüketildi, kullanıcı kaydı yok).
    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({ taskId: 'agent-r', toolUseId: 'toolu_launch', status: 'completed' })
      )
    );
    watcher.register({ toolCallId: 'toolu_launch', agentId: 'agent-r', sessionId: SESSION });
    // SendMessage ajanı yeniden başlattı: eski bitiş yeni çalışmayı kapatmamalı.
    watcher.register({
      toolCallId: 'toolu_resume',
      agentId: 'agent-r',
      sessionId: SESSION,
      resume: true,
    });
    await watcher.poll();
    expect(updates).toEqual([]);
    expect(watcher.activeCount).toBe(1);

    await appendFile(
      layout.sessionFile,
      enqueueLine(
        notification({
          taskId: 'agent-r',
          toolUseId: 'toolu_resume',
          status: 'completed',
          result: 'ikinci rapor',
        })
      )
    );
    await watcher.poll();
    expect(updates.map((u) => [u.agentId, u.toolCallId, u.status, u.summary])).toEqual([
      ['agent-r', 'toolu_resume', 'completed', 'ikinci rapor'],
    ]);
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('marks agents restored without any completion record as ended with unknown outcome', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'done-1', toolUseId: 'toolu_done', status: 'completed' }))
    );
    watcher.beginRestore();
    watcher.register({ toolCallId: 'toolu_done', agentId: 'done-1', sessionId: SESSION });
    watcher.register({ toolCallId: 'toolu_lost', agentId: 'lost-1', sessionId: SESSION });
    // Kaydı hiç bulunamayan ajan (geçici dizin ve proje kaydı yok).
    watcher.register({
      toolCallId: 'toolu_gone',
      agentId: 'gone-1',
      outputFile: join(layout.root, 'nowhere', 'gone-1.output'),
    });
    watcher.endRestore();
    await watcher.poll();
    const settled = [...updates].sort((left, right) =>
      (left.toolCallId ?? '').localeCompare(right.toolCallId ?? '')
    );
    expect(settled.map((u) => [u.toolCallId, u.status, u.statusUnknown ?? false])).toEqual([
      ['toolu_done', 'completed', false],
      ['toolu_gone', 'completed', true],
      ['toolu_lost', 'completed', true],
    ]);
    // Hiçbir şey izlenmiyor: yoklama zamanlayıcısı da durur.
    expect(watcher.activeCount).toBe(0);
    watcher.dispose();
  });

  it('does not expire agents started live after a restore', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.beginRestore();
    watcher.endRestore();
    watcher.register({ toolCallId: 'toolu_live', agentId: 'live-1', sessionId: SESSION });
    await watcher.poll();
    await watcher.poll();
    expect(updates).toEqual([]);
    expect(watcher.activeCount).toBe(1);
    watcher.dispose();
  });

  it('stops following an agent that settled through another path', async () => {
    const layout = await makeLayout();
    const { watcher, updates } = makeWatcher(layout.root);
    watcher.register({
      agentId: 'z1',
      toolCallId: 'tz',
      outputFile: await layout.outputFile('z1'),
    });
    watcher.settle({ toolCallId: 'tz' });
    expect(watcher.activeCount).toBe(0);
    await appendFile(
      layout.sessionFile,
      enqueueLine(notification({ taskId: 'z1', status: 'completed' }))
    );
    await watcher.poll();
    expect(updates).toEqual([]);
    watcher.dispose();
  });
});
