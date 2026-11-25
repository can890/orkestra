import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@orkestra/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAcpHarness } from '#runtimes/acp/node/acp-test-support';
import { SessionCell } from './cell';

const SESSION = '3b64607d-d203-4696-9efb-06a6424f89bf';
const SLUG = '-Users-test-project';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Claude Code'un arka plan görevi için diskte bıraktığı dosyaları kurar. */
async function makeClaudeLayout(agentId: string) {
  const root = await mkdtemp(join(tmpdir(), 'orkestra-bg-cell-'));
  roots.push(root);
  const projectDir = join(root, 'claude', 'projects', SLUG);
  const subagentsDir = join(projectDir, SESSION, 'subagents');
  const tasksDir = join(root, 'tmp', 'claude-501', SLUG, SESSION, 'tasks');
  await mkdir(subagentsDir, { recursive: true });
  await mkdir(tasksDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION}.jsonl`);
  await writeFile(sessionFile, '');
  const transcript = join(subagentsDir, `agent-${agentId}.jsonl`);
  await writeFile(transcript, '');
  const outputFile = join(tasksDir, `${agentId}.output`);
  await symlink(transcript, outputFile);
  return { sessionFile, outputFile };
}

function makeCell() {
  const h = makeAcpHarness();
  const cell = new SessionCell({
    conversationId: 'conv-bg',
    providerId: 'claude',
    acpSessionId: 'session-bg',
    agent: h.agent,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
  });
  cell.applySessionReady();
  return cell;
}

describe('SessionCell background Claude agents', () => {
  it('marks a background agent completed from the Claude session transcript after its turn ended', async () => {
    const agentId = 'a505cac4d761079b2';
    const { sessionFile, outputFile } = await makeClaudeLayout(agentId);
    const cell = makeCell();

    // Agent aracı çağrısı, ardından "arka planda başlatıldı" yanıtı (claude acp-transform çıktısı).
    cell.push({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'toolu_bg',
      title: 'Lane: dış ajan',
      status: 'pending',
      parentToolCallId: null,
      provider: 'claude',
    });
    cell.push({
      kind: 'subagent',
      operation: 'update',
      toolCallId: 'toolu_bg',
      title: 'Lane: dış ajan',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
      agentId,
      outputFile,
      provider: 'claude',
    });
    // Ana ajanın turu biter; arka plan ajanı çalışmayı sürdürür.
    cell.settleTurn({ kind: 'done', reason: 'end_turn' });
    expect(cell.transcript.agents).toHaveLength(1);
    expect(cell.transcript.agents[0]).toMatchObject({
      agentId,
      status: 'running',
      background: true,
    });

    // Claude Code bitişi yalnızca kendi oturum kaydına yazar.
    await appendFile(
      sessionFile,
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: SESSION,
        content: [
          '<task-notification>',
          `<task-id>${agentId}</task-id>`,
          '<tool-use-id>toolu_bg</tool-use-id>',
          `<output-file>${outputFile}</output-file>`,
          '<status>completed</status>',
          '<summary>Agent "Lane: dış ajan" finished</summary>',
          '<result>Rapor: 30/30 test geçti.</result>',
          '</task-notification>',
        ].join('\n'),
      })}\n`
    );

    await vi.waitFor(() => expect(cell.transcript.agents[0]?.status).toBe('completed'), {
      timeout: 5000,
      interval: 100,
    });
    expect(cell.transcript.agents[0]).toMatchObject({
      agentId,
      toolCallId: 'toolu_bg',
      status: 'completed',
      summary: 'Rapor: 30/30 test geçti.',
    });
    expect(cell.transcript.agents[0]?.completedAt).toBeTypeOf('number');
    cell.dispose();
  });

  it('settles a Claude agent whose launch reply never reached the stream (matched by tool call id)', async () => {
    // Canlı oturumda görülen durum: yalnızca araç çağrısının başlangıcı gelir; arka plan bayrağı,
    // görev kimliği ve çıktı dosyası hiç gelmez. Bitiş, oturum kimliğinden bulunan Claude kaydındaki
    // bildirimin araç çağrısı kimliğiyle eşleştirilir.
    const { sessionFile } = await makeClaudeLayout('unused');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(roots.at(-1)!, 'claude');
    try {
      const h = makeAcpHarness();
      const cell = new SessionCell({
        conversationId: 'conv-live',
        providerId: 'claude',
        acpSessionId: SESSION,
        agent: h.agent,
        resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
        logger: noopLogger,
      });
      cell.applySessionReady();
      cell.push({
        kind: 'subagent',
        operation: 'start',
        toolCallId: 'toolu_apk',
        title: 'Mobil APK derle ve telefona kur',
        status: 'in_progress',
        parentToolCallId: null,
        provider: 'claude',
      });
      expect(cell.transcript.agents[0]).toMatchObject({ status: 'running' });

      await appendFile(
        sessionFile,
        `${JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: SESSION,
          content: [
            '<task-notification>',
            '<task-id>af343b36db7764393</task-id>',
            '<tool-use-id>toolu_apk</tool-use-id>',
            '<status>completed</status>',
            '<summary>Agent "Mobil APK derle ve telefona kur" finished</summary>',
            '<result>APK 1.2.48 kuruldu.</result>',
            '</task-notification>',
          ].join('\n'),
        })}\n`
      );

      await vi.waitFor(() => expect(cell.transcript.agents[0]?.status).toBe('completed'), {
        timeout: 5000,
        interval: 100,
      });
      expect(cell.transcript.agents[0]).toMatchObject({
        toolCallId: 'toolu_apk',
        status: 'completed',
        summary: 'APK 1.2.48 kuruldu.',
      });
      cell.dispose();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('does not follow foreground agents or agents without an output file', async () => {
    const cell = makeCell();
    cell.push({
      kind: 'subagent',
      operation: 'start',
      toolCallId: 'toolu_fg',
      title: 'Explore',
      status: 'in_progress',
      parentToolCallId: null,
      provider: 'claude',
    });
    cell.push({
      kind: 'subagent',
      operation: 'update',
      toolCallId: 'toolu_fg',
      title: 'Explore',
      status: 'completed',
      parentToolCallId: null,
      summary: 'bitti',
    });
    expect(cell.transcript.agents[0]).toMatchObject({ status: 'completed', summary: 'bitti' });
    cell.settleTurn({ kind: 'done', reason: 'end_turn' });
    cell.dispose();
  });

  it('settles every agent of a session restored after all of them finished', async () => {
    // Zaman çizelgesi gerçek bir oturumun yapısını izler (kimlikler sentetik):
    // A: koşarken SendMessage kuyruğa alındı, ilk bitiş turun ortasında tüketildi (yalnızca
    //    oturum kaydında), sonra SendMessage ile yeniden başlatıldı, son bitiş o çağrının kimliğiyle.
    // B: düz bitiş (akışta kullanıcı kaydı). C: bitti, yeniden başlatıldı, yine bitti.
    // D: bitiş yalnızca oturum kaydında. E: hiçbir bitiş kaydı yok (süreç onu bitiremeden kapandı).
    const layout = await makeClaudeLayout('unused');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(roots.at(-1)!, 'claude');
    const ids = {
      A: 'a00000000000000aa',
      B: 'a00000000000000bb',
      C: 'a00000000000000cc',
      D: 'a00000000000000dd',
      E: 'a00000000000000ee',
    } as const;
    const enqueue = (taskId: string, toolUseId: string) =>
      `${JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: SESSION,
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>rapor ${toolUseId}</result>\n</task-notification>`,
      })}\n`;
    const remove = `${JSON.stringify({ type: 'queue-operation', operation: 'remove', sessionId: SESSION })}\n`;
    await appendFile(
      layout.sessionFile,
      enqueue(ids.B, 'toolu_B') +
        enqueue(ids.D, 'toolu_D') +
        remove +
        enqueue(ids.C, 'toolu_C') +
        enqueue(ids.A, 'toolu_A') +
        remove +
        enqueue(ids.C, 'toolu_send_C') +
        enqueue(ids.A, 'toolu_send_A')
    );
    try {
      const h = makeAcpHarness();
      const cell = new SessionCell({
        conversationId: 'conv-restore',
        providerId: 'claude',
        acpSessionId: SESSION,
        agent: h.agent,
        resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
        logger: noopLogger,
      });
      const launch = (key: keyof typeof ids) => {
        const toolCallId = `toolu_${key}`;
        cell.push({
          kind: 'subagent',
          operation: 'start',
          toolCallId,
          title: 'Agent',
          status: 'pending',
          parentToolCallId: null,
          provider: 'claude',
        });
        cell.push({
          kind: 'subagent',
          operation: 'update',
          toolCallId,
          title: `lane ${key}`,
          status: 'in_progress',
          parentToolCallId: null,
          background: true,
          agentId: ids[key],
          provider: 'claude',
        });
      };
      const sendMessage = (toolCallId: string, resumes?: string) => {
        cell.push({
          kind: 'tool_call',
          toolCallId,
          title: 'SendMessage',
          toolKind: 'other',
          status: 'pending',
          parentToolCallId: null,
          diffs: [],
          locations: [],
        });
        cell.push({
          kind: 'tool_update',
          toolCallId,
          status: 'completed',
          parentToolCallId: null,
          ...(resumes ? { resumesAgentId: resumes } : {}),
        });
      };
      const userRecord = (key: keyof typeof ids, toolUseId: string) =>
        cell.push({
          kind: 'subagent_update',
          agentId: ids[key],
          toolCallId: toolUseId,
          status: 'completed',
          summary: `rapor ${toolUseId}`,
        });
      const userMessage = (id: string) =>
        cell.push({ kind: 'message', role: 'user', messageId: id, text: `istek ${id}` });

      cell.beginReplay();
      userMessage('m1');
      for (const key of ['A', 'B', 'C', 'D', 'E'] as const) launch(key);
      sendMessage('toolu_send_queued');
      userRecord('B', 'toolu_B');
      userRecord('C', 'toolu_C');
      userMessage('m2');
      sendMessage('toolu_send_C', ids.C);
      sendMessage('toolu_send_A', ids.A);
      userRecord('C', 'toolu_send_C');
      userRecord('A', 'toolu_send_A');
      cell.applySessionLoaded();
      cell.endReplay();

      const spawnRows = () => {
        const rows: { toolCallId: string; status: string; statusUnknown?: boolean }[] = [];
        for (const turn of cell.transcript.history) {
          for (const item of turn.items) {
            if (item.kind === 'spawn-subagent-tool-call') rows.push(item);
          }
        }
        return rows;
      };
      await vi.waitFor(
        () => expect(cell.transcript.agents.filter((a) => a.status === 'running')).toEqual([]),
        { timeout: 5000, interval: 50 }
      );
      expect(
        spawnRows().map((row) => [row.toolCallId, row.status, row.statusUnknown ?? false])
      ).toEqual([
        ['toolu_A', 'done', false],
        ['toolu_B', 'done', false],
        ['toolu_C', 'done', false],
        ['toolu_D', 'done', false],
        ['toolu_E', 'done', true],
      ]);
      expect(
        cell.transcript.agents.map((a) => [a.toolCallId, a.status, a.statusUnknown ?? false])
      ).toEqual([
        ['toolu_A', 'completed', false],
        ['toolu_B', 'completed', false],
        ['toolu_C', 'completed', false],
        ['toolu_D', 'completed', false],
        ['toolu_E', 'completed', true],
      ]);
      expect(cell.transcript.agents[0]?.summary).toBe('rapor toolu_send_A');
      cell.dispose();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('keeps a live resumed agent running until the resuming call completes in the record', async () => {
    const agentId = 'a00000000000000ff';
    const { sessionFile, outputFile } = await makeClaudeLayout(agentId);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(roots.at(-1)!, 'claude');
    try {
      const h = makeAcpHarness();
      const cell = new SessionCell({
        conversationId: 'conv-resume-live',
        providerId: 'claude',
        acpSessionId: SESSION,
        agent: h.agent,
        resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
        logger: noopLogger,
      });
      cell.applySessionReady();
      cell.push({
        kind: 'subagent',
        operation: 'start',
        toolCallId: 'toolu_lane',
        title: 'lane',
        status: 'in_progress',
        parentToolCallId: null,
        background: true,
        agentId,
        outputFile,
        provider: 'claude',
      });
      const line = (toolUseId: string, result: string) =>
        `${JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: SESSION,
          content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>${result}</result>\n</task-notification>`,
        })}\n`;
      await appendFile(sessionFile, line('toolu_lane', 'ilk'));
      await vi.waitFor(() => expect(cell.transcript.agents[0]?.status).toBe('completed'), {
        timeout: 5000,
        interval: 50,
      });

      cell.push({
        kind: 'tool_call',
        toolCallId: 'toolu_send',
        title: 'SendMessage',
        toolKind: 'other',
        status: 'pending',
        parentToolCallId: null,
        diffs: [],
        locations: [],
      });
      cell.push({
        kind: 'tool_update',
        toolCallId: 'toolu_send',
        status: 'completed',
        parentToolCallId: null,
        resumesAgentId: agentId,
      });
      expect(cell.transcript.agents[0]).toMatchObject({
        status: 'running',
        toolCallId: 'toolu_lane',
      });
      // Önceki bitiş kaydı yeniden okunsa da yeniden başlatılan çalışma "bitti" görünmez.
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(cell.transcript.agents[0]?.status).toBe('running');

      await appendFile(sessionFile, line('toolu_send', 'ikinci'));
      await vi.waitFor(() => expect(cell.transcript.agents[0]?.status).toBe('completed'), {
        timeout: 5000,
        interval: 50,
      });
      expect(cell.transcript.agents[0]).toMatchObject({
        toolCallId: 'toolu_lane',
        summary: 'ikinci',
      });
      cell.dispose();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
