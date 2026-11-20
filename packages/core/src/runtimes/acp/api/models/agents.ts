import { z } from 'zod';

export const agentStatusSchema = z.enum(['running', 'completed', 'failed']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentActivityEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['thinking', 'tool', 'message', 'error', 'status']),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(['running', 'done', 'error']).optional(),
  timestamp: z.number().optional(),
});
export type AgentActivityEntry = z.infer<typeof agentActivityEntrySchema>;

export const agentStateSchema = z.object({
  /** Provider/runtime id for the spawned agent; stable across later status notifications. */
  agentId: z.string(),
  /** Tool call that launched or represents this agent in the transcript. */
  toolCallId: z.string(),
  /** Turn that launched the agent; null only for orphan updates whose launch was never observed. */
  launchTurnId: z.string().nullable(),
  name: z.string(),
  status: agentStatusSchema,
  /** Epoch ms when the runtime first observed this agent. */
  startedAt: z.number(),
  /** Epoch ms when the agent reached a terminal status. Absent while running. */
  completedAt: z.number().optional(),
  /** True for Claude-style async/background agents that can outlive their launch turn. */
  background: z.boolean().optional(),
  /** Provider-managed file containing background-agent output, when available. */
  outputFile: z.string().optional(),
  /** Provider-supplied completion summary for background-agent updates. */
  summary: z.string().optional(),
  /** Initial prompt given to the subagent. */
  prompt: z.string().optional(),
  /** Subagent type or role label (e.g. research, self, browser). */
  role: z.string().optional(),
  /** Provider running the subagent (e.g. antigravity, codex, claude, kimi, grok, gemini). */
  provider: z.string().optional(),
  /** Human-readable or slug model running the subagent. */
  model: z.string().optional(),
  /** Reasoning effort level (e.g. low, medium, high, xhigh, max). */
  effort: z.string().optional(),
  /** Live activity timeline entries captured from the subagent. */
  activities: z.array(agentActivityEntrySchema).optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;
