/**
 * T3AgentTools — Extra agent MCP server (`orkestra-extras`) providing:
 * - `request_secret` (one-use 0600 file or token ref without leaking plaintext into transcript)
 * - `worktree_status` (branch, worktree path, origin ahead/behind, dirty count)
 * - `pull_request_status` (PR readiness, reviews, required checks via `gh`)
 * - `ci_logs` (failed GitHub Actions check logs via `gh run view --log-failed`)
 * - `ci_rerun` (re-run failed GitHub Actions jobs via `gh run rerun --failed`)
 *
 * Adapted from T3 Code (MIT License) SecretRequests.ts, WorktreeMcpService.ts,
 * and toolkits/pullRequests/.
 */

import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isLocalHostRef } from '@orkestra/core/primitives/host/api';
import type { Logger } from '@orkestra/shared/logger';
import { BrowserWindow, dialog } from 'electron';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';

const execFileAsync = promisify(execFile);

export const T3_EXTRAS_MCP_SERVER_NAME = 'orkestra-extras';
export const T3_EXTRAS_TOOLS_SERVER_ID = 't3-extras';

const T3_EXTRAS_INSTRUCTIONS = [
  'Orkestra workflow tools for secrets, git worktrees, and GitHub PR/CI checks.',
  '- Use request_secret when a command needs a secret/token/PIN from the user; never ask for secrets in plain chat.',
  '- Use worktree_status to inspect current branch, worktree path, and origin/main divergence.',
  '- Use pull_request_status, ci_logs, and ci_rerun to inspect PR readiness and debug failed GitHub Actions runs.',
].join('\n');

const T3_EXTRAS_TOOLS = [
  {
    name: 'request_secret',
    description:
      'Prompt the user securely for a single secret value and deliver it via a temporary 0600 file path (so the plaintext never enters the chat transcript).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short label for the secret (e.g. "GitHub Token").' },
        reason: { type: 'string', description: 'Why this secret is needed.' },
      },
      required: ['label', 'reason'],
      additionalProperties: false,
    },
    annotations: { title: 'Request secret securely', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'worktree_status',
    description: 'Inspect current git worktree path, branch name, upstream divergence, and modified file count.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional working directory override.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Worktree status', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'pull_request_status',
    description: 'Read current branch or numbered pull request state, reviews, mergeability, and CI check status.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'Optional PR number; defaults to current branch PR.' },
        cwd: { type: 'string', description: 'Optional repository directory.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Pull request status', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ci_logs',
    description: 'Fetch failed step logs for a GitHub Actions workflow run (or the latest failed run on the current branch).',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Optional workflow run ID. Omit to inspect the latest failed run.' },
        cwd: { type: 'string', description: 'Optional repository directory.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Read CI failure logs', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ci_rerun',
    description: 'Re-run failed jobs in a GitHub Actions workflow run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Workflow run ID to rerun.' },
        cwd: { type: 'string', description: 'Optional repository directory.' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Rerun failed CI jobs', readOnlyHint: false, openWorldHint: true },
  },
] as const;

export type T3AgentToolsDeps = {
  tools: AgentToolsBridgeHost;
  secretsTmpDir: string;
  logger: Logger;
};

async function secureDelete(filePath: string): Promise<void> {
  try {
    const fh = await open(filePath, 'r+');
    try {
      const info = await fh.stat();
      if (info.size > 0) {
        await fh.write(Buffer.alloc(info.size, 0), 0, info.size, 0);
      }
    } finally {
      await fh.close();
    }
  } catch {
    // ignore overwrite errors
  }
  await unlink(filePath).catch(() => undefined);
}

async function promptSecretViaDialog(label: string, reason: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const safeLabel = label.replace(/["\\]/g, ' ').slice(0, 120);
    const safeReason = reason.replace(/["\\]/g, ' ').slice(0, 260);
    const script = `display dialog "${safeReason}" with title "Sovra · ${safeLabel}" default answer "" with hidden answer buttons {"İptal", "Gönder"} default button "Gönder"`;
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
        timeout: 120_000,
      });
      const match = /text returned:(.*)$/s.exec(stdout.trim());
      return match ? match[1]!.replace(/\r?\n$/, '') : null;
    } catch {
      return null;
    }
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  await dialog.showMessageBox(win ?? ({} as BrowserWindow), {
    type: 'info',
    title: `Sovra · ${label}`,
    message: reason,
    detail: 'Güvenli gizli değer istemi yalnızca macOS iletişim kutusuyla desteklenir.',
  });
  return null;
}

export class T3AgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly contextByToken = new Map<string, { conversationId: string; cwd?: string }>();
  private readonly contextByConv = new Map<string, { cwd?: string }>();
  private readonly secretFiles = new Set<string>();
  private readonly unregister: () => void;

  constructor(private readonly deps: T3AgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: T3_EXTRAS_TOOLS_SERVER_ID,
      authenticate: (token) => this.contextByToken.get(token)?.conversationId ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!isLocalHostRef(context.host)) return [];
    const cwd = (context as { cwd?: string; workspacePath?: string }).cwd ??
      (context as { workspacePath?: string }).workspacePath;
    this.contextByConv.set(context.conversationId, { cwd });
    const server = await this.deps.tools.bridgeServer({
      name: T3_EXTRAS_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId, cwd),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: T3_EXTRAS_TOOLS_SERVER_ID,
    });
    return server ? [server] : [];
  }

  dispose(): void {
    this.unregister();
    for (const file of this.secretFiles) {
      void secureDelete(file);
    }
    this.secretFiles.clear();
  }

  private tokenFor(conversationId: string, cwd?: string): string {
    let token = this.tokens.get(conversationId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(conversationId, token);
    }
    this.contextByToken.set(token, { conversationId, cwd });
    return token;
  }

  private async handle(
    conversationId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (method === 'describe') {
      return {
        name: T3_EXTRAS_MCP_SERVER_NAME,
        instructions: T3_EXTRAS_INSTRUCTIONS,
        tools: T3_EXTRAS_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const name = typeof params.name === 'string' ? params.name : '';
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    const defaultCwd = this.contextByConv.get(conversationId)?.cwd;
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : defaultCwd;

    this.deps.logger.debug('Orkestra extras aracı çağrıldı', { conversationId, tool: name });

    switch (name) {
      case 'request_secret':
        return this.runRequestSecret(args);
      case 'worktree_status':
        return this.runWorktreeStatus(cwd);
      case 'pull_request_status':
        return this.runPrStatus(args, cwd);
      case 'ci_logs':
        return this.runCiLogs(args, cwd);
      case 'ci_rerun':
        return this.runCiRerun(args, cwd);
      default:
        return failure(`Unknown tool: ${name}`);
    }
  }

  private async runRequestSecret(args: Record<string, unknown>): Promise<AgentToolCallResult> {
    const label = typeof args.label === 'string' ? args.label.trim() : 'Gizli Değer';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : 'Bu işlem için gizli değer gerekiyor.';
    const value = await promptSecretViaDialog(label, reason);
    if (value === null || value.length === 0) {
      return failure('Kullanıcı gizli değer girişini iptal etti.');
    }
    await mkdir(this.deps.secretsTmpDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.deps.secretsTmpDir, `secret-${randomUUID()}.tmp`);
    await writeFile(filePath, value, { mode: 0o600, encoding: 'utf8' });
    await chmod(filePath, 0o600);
    this.secretFiles.add(filePath);
    // 10 dakika sonra otomatik güvenli silme
    const timer = setTimeout(() => {
      this.secretFiles.delete(filePath);
      void secureDelete(filePath);
    }, 10 * 60_000);
    timer.unref();
    return text(
      JSON.stringify({
        delivered: true,
        delivery: 'file',
        filePath,
        note: 'Read this 0600 file directly in your shell command (e.g. "$(cat <filePath>)"). Never print its contents to the transcript.',
      })
    );
  }

  private async runWorktreeStatus(cwd?: string): Promise<AgentToolCallResult> {
    if (!cwd) return failure('Working directory (cwd) is required for worktree_status.');
    try {
      const [top, branch, status, div] = await Promise.all([
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }),
        execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10_000 }),
        execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 10_000 }),
        execFileAsync('git', ['-C', cwd, 'rev-list', '--left-right', '--count', 'origin/main...HEAD'], {
          timeout: 10_000,
        }).catch(() => ({ stdout: '' })),
      ]);
      const dirtyLines = status.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const [behind, ahead] = div.stdout
        .trim()
        .split(/\s+/)
        .map((n) => Number.parseInt(n, 10));
      return text(
        JSON.stringify(
          {
            worktreePath: top.stdout.trim(),
            branch: branch.stdout.trim(),
            dirtyFileCount: dirtyLines.length,
            behindOriginMain: Number.isFinite(behind) ? behind : null,
            aheadOfOriginMain: Number.isFinite(ahead) ? ahead : null,
          },
          null,
          2
        )
      );
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }

  private async runPrStatus(args: Record<string, unknown>, cwd?: string): Promise<AgentToolCallResult> {
    const argv = ['pr', 'view'];
    if (typeof args.number === 'number' && Number.isInteger(args.number) && args.number > 0) {
      argv.push(String(args.number));
    }
    argv.push(
      '--json',
      'number,title,state,url,isDraft,mergeable,reviewDecision,headRefName,baseRefName,statusCheckRollup'
    );
    try {
      const { stdout } = await execFileAsync('gh', argv, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      return text(stdout.trim() || '{}');
    } catch (error) {
      return failure(`gh pr view failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runCiLogs(args: Record<string, unknown>, cwd?: string): Promise<AgentToolCallResult> {
    try {
      let runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
      if (!runId) {
        const list = await execFileAsync(
          'gh',
          ['run', 'list', '--status', 'failure', '--limit', '1', '--json', 'databaseId,name,headBranch'],
          { cwd, timeout: 20_000 }
        );
        const parsed = JSON.parse(list.stdout || '[]') as Array<{ databaseId?: number }>;
        if (!parsed[0]?.databaseId) {
          return text('No failed GitHub Actions runs found.');
        }
        runId = String(parsed[0].databaseId);
      }
      if (!/^\d+$/.test(runId)) return failure('run_id must be numeric.');
      const { stdout } = await execFileAsync('gh', ['run', 'view', runId, '--log-failed'], {
        cwd,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const trimmed = stdout.trim();
      return text(trimmed.length > 24_000 ? `${trimmed.slice(-24_000)}` : trimmed || 'No failed log output.');
    } catch (error) {
      return failure(`ci_logs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runCiRerun(args: Record<string, unknown>, cwd?: string): Promise<AgentToolCallResult> {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
    if (!/^\d+$/.test(runId)) return failure('run_id must be a numeric GitHub Actions run ID.');
    try {
      await execFileAsync('gh', ['run', 'rerun', runId, '--failed'], { cwd, timeout: 20_000 });
      return text(`Triggered rerun of failed jobs for workflow run ${runId}.`);
    } catch (error) {
      return failure(`ci_rerun failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function text(value: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: value }] };
}

function failure(message: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
