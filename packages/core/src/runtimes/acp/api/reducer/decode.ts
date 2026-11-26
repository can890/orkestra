/**
 * Baseline ACP SessionUpdate decoder.
 *
 * Converts raw ACP SDK SessionUpdate notifications into the parser's internal
 * NormalizedEvent vocabulary. This is the parser-owned equivalent of the
 * legacy toAgentUpdate in agent-update.ts — it is stateless, pure, and
 * handles all ACP-specific decoding:
 *
 *   - Extracts text from content blocks for message and thinking variants.
 *   - Extracts diff blocks from ToolCallContent arrays.
 *   - Passes status and kind through unchanged (no UI-level remapping here); an Orkestra kind
 *     carried in `_meta.orkestra.toolKind` takes precedence over the ACP `kind`.
 *   - Preserves missing message ids for the stateful reducer to segment.
 *   - Sets parentToolCallId to null (providers enrich via EnrichHook).
 *   - Returns { kind: 'ignored' } for variants not yet rendered.
 */

import type { SessionUpdate, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk';
import { extractMcpCall } from '#primitives/acp-transcript/api/mcp-app';
import { extractWidgetInput } from '#primitives/acp-transcript/api/widget';
import type { PlanEntryInput, PlanEntryPriority, PlanEntryStatus } from '../models/plan';
import { stripHiddenContextFromTitle } from '../models/hidden-context';
import { readReplayedUserText, replayedImageAttachment } from '../models/replayed-user-attachments';
import { extractArtifacts } from './artifact-content';
import type {
  NormalizedDiff,
  NormalizedEvent,
  NormalizedToolLocation,
  NormalizedToolStatus,
} from './normalized-event';
import {
  readBackgroundTask,
  readDetached,
  readExtendedToolKind,
  readStatusUnknown,
} from './tool-kind';

function extractDiffs(
  content: ReadonlyArray<ToolCallContent> | null | undefined
): NormalizedDiff[] {
  if (!content) return [];
  const diffs: NormalizedDiff[] = [];
  for (const block of content) {
    if (block.type === 'diff') {
      diffs.push({ path: block.path, oldText: block.oldText ?? null, newText: block.newText });
    }
  }
  return diffs;
}

function extractLocations(
  locations: ReadonlyArray<ToolCallLocation> | null | undefined
): NormalizedToolLocation[] {
  return (locations ?? []).map((location) => ({
    path: location.path,
    ...(location.line !== undefined && location.line !== null ? { line: location.line } : {}),
  }));
}

function hasOwnField<T extends object>(value: T, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function collectTextPayload(value: unknown, parts: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTextPayload(item, parts);
    return;
  }

  const raw = value as { type?: unknown; text?: unknown; content?: unknown };
  if (raw.type === 'text' && typeof raw.text === 'string') {
    parts.push(raw.text);
    return;
  }
  collectTextPayload(raw.content, parts);
}

function stripSingleCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1] : text;
}

function extractTextOutput(
  content: ReadonlyArray<ToolCallContent> | null | undefined
): string | undefined {
  if (!content) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const raw = block as { type?: unknown; content?: unknown; text?: unknown };
    if (raw.type === 'content') {
      collectTextPayload(raw.content, parts);
    } else if (raw.type === 'text' && typeof raw.text === 'string') {
      parts.push(raw.text);
    }
  }
  const text = parts.join('\n');
  return text ? stripSingleCodeFence(text) : undefined;
}

function extractTerminalId(update: SessionUpdate): string | undefined {
  const raw = update as unknown as { terminalId?: unknown; terminal_id?: unknown };
  if (typeof raw.terminalId === 'string') return raw.terminalId;
  if (typeof raw.terminal_id === 'string') return raw.terminal_id;
  return undefined;
}

/**
 * Provider-supplied one-line purpose of a tool call. Checked on the update
 * itself and inside `rawInput` (Claude Code's Bash tool carries a
 * `description` argument there, and only on the `tool_call_update` that also
 * delivers the command). Adapters that wrap MCP tool arguments carry it one
 * level deeper (codex-acp: `rawInput: { server, tool, arguments }`).
 */
function extractInputSummary(update: SessionUpdate): string | undefined {
  const raw = update as unknown as {
    inputSummary?: unknown;
    input_summary?: unknown;
    description?: unknown;
    rawInput?: { description?: unknown; arguments?: unknown } | null;
  };
  if (typeof raw.inputSummary === 'string') return raw.inputSummary;
  if (typeof raw.input_summary === 'string') return raw.input_summary;
  if (typeof raw.description === 'string') return raw.description;
  if (typeof raw.rawInput?.description === 'string') return raw.rawInput.description;
  return wrappedArgumentsDescription(raw.rawInput?.arguments);
}

/**
 * `description` of wrapped tool arguments. These are arbitrary MCP tool
 * parameters, so only a single-line value counts as the call's purpose; a
 * multi-line one is content (an issue or PR body), not a summary.
 */
function wrappedArgumentsDescription(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const description = (args as { description?: unknown }).description;
  if (typeof description !== 'string') return undefined;
  const trimmed = description.trim();
  return trimmed && !trimmed.includes('\n') ? description : undefined;
}

const PLAN_TOOL_NAME_RE =
  /^(?:update_steps|todowrite|todo_write|write_todos|update_plan)$/i;

function normalizePlanEntryStatus(raw: unknown): PlanEntryStatus {
  if (typeof raw !== 'string') return 'pending';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'done') return 'completed';
  if (
    normalized === 'in_progress' ||
    normalized === 'in-progress' ||
    normalized === 'running' ||
    normalized === 'active'
  ) {
    return 'in_progress';
  }
  return 'pending';
}

function normalizePlanEntryPriority(raw: unknown): PlanEntryPriority {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

function parsePlanItemsArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function extractPlanEntriesFromRawInput(rawInput: unknown): PlanEntryInput[] | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  const wrappedArgs =
    input.arguments && typeof input.arguments === 'object'
      ? (input.arguments as Record<string, unknown>)
      : undefined;
  const source = wrappedArgs ?? input;
  const rawList =
    parsePlanItemsArray(source.steps) ??
    parsePlanItemsArray(source.todos) ??
    parsePlanItemsArray(source.plan);
  if (!rawList) return null;

  const entries: PlanEntryInput[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text =
      (typeof record.title === 'string' && record.title.trim()) ||
      (typeof record.content === 'string' && record.content.trim()) ||
      (typeof record.step === 'string' && record.step.trim()) ||
      (typeof record.description === 'string' && record.description.trim()) ||
      '';
    if (!text) continue;
    entries.push({
      content: text,
      status: normalizePlanEntryStatus(record.status),
      priority: normalizePlanEntryPriority(record.priority),
    });
  }
  return entries.length > 0 ? entries : null;
}

function isPlanToolUpdate(update: SessionUpdate): boolean {
  const raw = update as unknown as {
    title?: unknown;
    name?: unknown;
    _meta?: { claudeCode?: { toolName?: unknown } } | null;
    rawInput?: { tool?: unknown } | null;
  };
  const candidates = [
    raw._meta?.claudeCode?.toolName,
    raw.name,
    raw.rawInput?.tool,
    raw.title,
  ];
  return candidates.some((c) => typeof c === 'string' && PLAN_TOOL_NAME_RE.test(c.trim()));
}

function extractMessageTimestamp(update: SessionUpdate): number | undefined {
  const raw = update as unknown as {
    _meta?: { timestamp?: unknown; createdAt?: unknown } | null;
    timestamp?: unknown;
    createdAt?: unknown;
  };
  const candidate = raw._meta?.timestamp ?? raw._meta?.createdAt ?? raw.timestamp ?? raw.createdAt;
  if (
    typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= 1_000_000_000_000
  ) {
    return candidate;
  }
  if (typeof candidate === 'string' && candidate.trim()) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed) && parsed >= 1_000_000_000_000) return parsed;
  }
  return undefined;
}

/**
 * Decode a raw ACP SessionUpdate into a NormalizedEvent.
 * Stateless — does not depend on turn or session context.
 */
export function decodeSessionUpdate(update: SessionUpdate): NormalizedEvent {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const content = update.content;
      const image =
        content.type === 'image'
          ? replayedImageAttachment(`data:${content.mimeType};base64,${content.data}`)
          : undefined;
      const { text, attachments } =
        content.type === 'text'
          ? readReplayedUserText(content.text)
          : { text: '', attachments: image ? [image] : [] };
      if (!text && attachments.length === 0) return { kind: 'ignored' };
      const createdAt = extractMessageTimestamp(update);
      return {
        kind: 'message',
        role: 'user',
        messageId: update.messageId ?? null,
        text,
        ...(attachments.length ? { attachments } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      };
    }

    case 'agent_message_chunk': {
      const artifacts = extractArtifacts(update.content);
      const text = update.content.type === 'text' ? update.content.text : '';
      if (!text && !artifacts.length) return { kind: 'ignored' };
      const createdAt = extractMessageTimestamp(update);
      return {
        kind: 'message',
        role: 'assistant',
        messageId: update.messageId ?? null,
        text,
        ...(artifacts.length ? { artifacts } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      };
    }

    case 'agent_thought_chunk': {
      if (update.content.type !== 'text' || !update.content.text) return { kind: 'ignored' };
      return {
        kind: 'thinking',
        messageId: update.messageId ?? null,
        text: update.content.text,
      };
    }

    case 'tool_call': {
      if (isPlanToolUpdate(update)) {
        const entries = extractPlanEntriesFromRawInput(update.rawInput);
        if (entries) return { kind: 'plan', entries };
        return { kind: 'ignored' };
      }
      const terminalId = extractTerminalId(update);
      const inputSummary = extractInputSummary(update);
      const artifacts = extractArtifacts([update.content, update.rawOutput]);
      const widget = extractWidgetInput(update.rawInput);
      const mcpCall = extractMcpCall(update);
      return {
        kind: 'tool_call',
        ...(artifacts.length ? { artifacts } : {}),
        ...(widget !== undefined ? { widget } : {}),
        ...(mcpCall !== undefined ? { mcpCall } : {}),
        toolCallId: update.toolCallId,
        title: update.title,
        // Orkestra's own kinds (e.g. `subagent`) travel in `_meta.orkestra.toolKind` because the
        // ACP contract only allows a fixed `kind` set; see tool-kind.ts.
        toolKind: readExtendedToolKind(update) ?? update.kind ?? null,
        status: (update.status as NormalizedToolStatus | undefined) ?? null,
        parentToolCallId: null,
        diffs: extractDiffs(update.content),
        locations: extractLocations(update.locations),
        ...(inputSummary !== undefined ? { inputSummary } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
        ...(readBackgroundTask(update) ? { backgroundTask: true as const } : {}),
        ...(readDetached(update) ? { detached: true as const } : {}),
        ...(readStatusUnknown(update) ? { statusUnknown: true as const } : {}),
      };
    }

    case 'tool_call_update': {
      if (isPlanToolUpdate(update)) {
        const entries = extractPlanEntriesFromRawInput(update.rawInput);
        if (entries) return { kind: 'plan', entries };
        return { kind: 'ignored' };
      }
      const inputSummary = extractInputSummary(update);
      const outputText = extractTextOutput(update.content ?? undefined);
      const terminalId = extractTerminalId(update);
      const hasContent = hasOwnField(update, 'content');
      const artifacts = extractArtifacts([update.content, update.rawOutput]);
      const hasLocations = hasOwnField(update, 'locations');
      const widget = extractWidgetInput(update.rawInput);
      const mcpCall = extractMcpCall(update);
      const extendedKind = readExtendedToolKind(update);
      return {
        kind: 'tool_update',
        ...(artifacts.length ? { artifacts } : {}),
        ...(widget !== undefined ? { widget } : {}),
        ...(mcpCall !== undefined ? { mcpCall } : {}),
        toolCallId: update.toolCallId,
        parentToolCallId: null,
        ...(hasOwnField(update, 'title') ? { title: update.title ?? null } : {}),
        ...(extendedKind !== undefined
          ? { toolKind: extendedKind }
          : hasOwnField(update, 'kind')
            ? { toolKind: update.kind ?? null }
            : {}),
        ...(hasOwnField(update, 'status')
          ? { status: (update.status as NormalizedToolStatus | undefined | null) ?? null }
          : {}),
        ...(hasContent ? { diffs: extractDiffs(update.content) } : {}),
        ...(hasLocations ? { locations: extractLocations(update.locations) } : {}),
        ...(inputSummary !== undefined ? { inputSummary } : {}),
        ...(outputText !== undefined ? { outputText } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
        ...(readBackgroundTask(update) ? { backgroundTask: true as const } : {}),
        ...(readDetached(update) ? { detached: true as const } : {}),
        ...(readStatusUnknown(update) ? { statusUnknown: true as const } : {}),
      };
    }

    case 'plan': {
      const rawEntries = Array.isArray(update.entries) ? update.entries : [];
      const entries: PlanEntryInput[] = [];
      for (const rawEntry of rawEntries) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const rec = rawEntry as unknown as Record<string, unknown>;
        const content =
          (typeof rec.content === 'string' && rec.content.trim()) ||
          (typeof rec.title === 'string' && rec.title.trim()) ||
          (typeof rec.step === 'string' && rec.step.trim()) ||
          '';
        if (!content) continue;
        entries.push({
          content,
          status: normalizePlanEntryStatus(rec.status),
          priority: normalizePlanEntryPriority(rec.priority),
        });
      }
      return {
        kind: 'plan',
        entries,
      };
    }

    case 'config_option_update': {
      const raw = update as unknown as { configOptions?: unknown };
      const options = Array.isArray(raw.configOptions) ? raw.configOptions : [];
      return { kind: 'config', options };
    }

    case 'current_mode_update': {
      const raw = update as unknown as { currentModeId?: string };
      if (!raw.currentModeId) return { kind: 'ignored' };
      return { kind: 'mode_selected', modeId: raw.currentModeId };
    }

    case 'available_commands_update': {
      const raw = update as unknown as { availableCommands?: unknown };
      const commands = Array.isArray(raw.availableCommands) ? raw.availableCommands : [];
      return { kind: 'commands', commands };
    }

    case 'usage_update': {
      const raw = update as unknown as {
        used?: number;
        size?: number;
        cost?: { amount?: number; currency?: string } | null;
      };
      const contextUsed = raw.used ?? 0;
      const contextSize = raw.size ?? 0;
      const cost =
        raw.cost && typeof raw.cost.amount === 'number' && raw.cost.currency
          ? { amount: raw.cost.amount, currency: raw.cost.currency }
          : null;
      return { kind: 'usage', usage: { contextUsed, contextSize, cost } };
    }

    case 'session_info_update': {
      const raw = update as unknown as { title?: string };
      if (!raw.title) return { kind: 'ignored' };
      // Providers that derive the title from the first prompt would leak the hidden block.
      const title = stripHiddenContextFromTitle(raw.title);
      if (!title) return { kind: 'ignored' };
      return { kind: 'title', title };
    }

    // plan_update and plan_removed are UNSTABLE/ID-based ACP variants gated
    // behind PlanCapabilities — not emitted by Claude. Ignored for now.
    default:
      return { kind: 'ignored' };
  }
}
