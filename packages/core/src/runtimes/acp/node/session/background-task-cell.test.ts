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
});
