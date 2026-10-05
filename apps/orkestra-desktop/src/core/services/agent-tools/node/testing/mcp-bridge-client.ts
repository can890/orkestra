import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentToolsMcpServer } from '@core/services/agent-tools/api/agent-tools';

export type McpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type McpToolContent = { type: string; text?: string; data?: string; mimeType?: string };

/**
 * Testlerde köprüyü ACP ajanının yaptığı gibi alt süreç olarak başlatır ve satır sınırlı
 * JSON-RPC ile konuşur. Yalnızca testler içindir.
 */
export class McpBridgeClient {
  private buffer = '';
  private nextId = 1;
  private readonly waiters = new Map<number, (message: McpResponse) => void>();
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, index)) as McpResponse;
        this.buffer = this.buffer.slice(index + 1);
        if (typeof message.id === 'number') this.waiters.get(message.id)?.(message);
      }
    });
  }

  /** Köprüyü verilen MCP sunucu tanımıyla başlatır (komut, argümanlar, ortam). */
  static start(server: AgentToolsMcpServer, env: Record<string, string> = {}): McpBridgeClient {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env, ...env },
    });
    return new McpBridgeClient(child);
  }

  request(method: string, params?: unknown): Promise<McpResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ isError: boolean; content: McpToolContent[]; text: string }> {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: McpToolContent[]; isError: boolean };
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
    return { isError: result.isError, content: result.content, text };
  }

  endInput(): void {
    this.child.stdin.end();
  }

  kill(): void {
    this.child.kill();
  }
}
