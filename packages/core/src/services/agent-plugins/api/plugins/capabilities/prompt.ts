import { definePluginCapability } from '@orkestra/shared/plugins';
import z from 'zod';

export type CommandContext = {
  cli: string; // absolute path to the cli binary
  extraArgs?: string[]; // user-configured in settings
  autoApprove: boolean;
  initialPrompt?: string;
  /** Orkestra conversation UUID — used as the session token for providers that track their
   * own session across the orkestra lifetime (e.g. claude --session-id, opencode --session). */
  sessionId?: string;
  /** Provider-native session identifier stored by the agent classifier. When present, used
   * for resume on providers that generate their own session IDs (e.g. grok, copilot, kimi,
   * codex, droid). Undefined means the provider has not yet emitted a session ID. */
  providerSessionId?: string;
  isResuming?: boolean;
  model: string;
};

export type AgentCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * A conversation-scoped stdio MCP server (e.g. Orkestra's own tool servers) handed to a TUI
 * session for its lifetime only. `env` may carry secrets (per-conversation tokens); providers
 * must keep them out of process arguments where the CLI allows it.
 */
export type SessionMcpServer = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type SessionMcpContext = {
  /** Platform of the machine running the TUI session (local or remote host). */
  platform: NodeJS.Platform;
  /** Absolute path of a file in the session's private (0700) config directory. */
  filePath(name: string): string;
};

export type SessionMcpLaunch = {
  /** Prepended to the provider command's arguments. */
  args: string[];
  /** Written by the runtime with mode 0600 into the session config directory. */
  files: { name: string; contents: string }[];
};

type Prompt = {
  buildCommand(ctx: CommandContext): AgentCommand;
  /**
   * Per-session MCP mechanism of the provider CLI (e.g. `--mcp-config <file>`). Must be additive:
   * the user's own MCP configuration stays untouched. Providers without such a mechanism omit
   * it and TUI sessions run without Orkestra's tool servers.
   */
  buildSessionMcp?(servers: SessionMcpServer[], ctx: SessionMcpContext): SessionMcpLaunch;
};

/**
 * PromptDeliveryOption is used to describe a prompt delivery that an agent supports.
 * @param kind - The kind of prompt delivery option.
 */
export const promptCapability = definePluginCapability<Prompt>()(
  'prompt-delivery',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('argv'),
      flag: z.string().optional(),
    }),
    z.object({
      kind: z.literal('pty-only'),
    }),
    z.object({
      kind: z.literal('stdin-pipe'),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  undefined,
  {
    requiresBehavior: (descriptor) => descriptor.kind !== 'none',
  }
);
