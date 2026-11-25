import type { TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';

/**
 * Turn liveness for the chat: tells a long, legitimately running turn apart from one that has
 * silently stopped, without timing anything out.
 *
 * Nothing is cancelled here. A turn whose tools are still running (an image or video job can run
 * for many minutes, or an agent waits on its own background task) is only described after a long
 * silence; a turn with no running tool and no provider update for STALLED_AFTER_MS is reported as
 * probably stuck. Both offer the user an explicit way out.
 */

/** No provider update and no running tool for this long: the turn has most likely stopped. */
export const STALLED_AFTER_MS = 5 * 60_000;
/** A running tool may legitimately take long; describe the wait only after this much silence. */
export const WAITING_NOTICE_AFTER_MS = 10 * 60_000;

export type TurnLiveness =
  | { kind: 'healthy' }
  | { kind: 'waiting-on-tools'; silentForMs: number; tools: string[] }
  | { kind: 'stalled'; silentForMs: number };

export interface TurnLivenessInput {
  isWorking: boolean;
  /** Runtime-reported liveness (`SessionState.activity`); absent on older runtimes. */
  activity?: { turnStartedAt: number; lastActivityAt: number };
  /** Fallback when the runtime does not report activity: last change this client observed. */
  observedActivityAt: number | null;
  activeTurn: TranscriptTurn | null | undefined;
  now: number;
}

export function assessTurnLiveness(input: TurnLivenessInput): TurnLiveness {
  if (!input.isWorking) return { kind: 'healthy' };
  const lastActivityAt = Math.max(
    input.activity?.lastActivityAt ?? Number.NEGATIVE_INFINITY,
    input.observedActivityAt ?? Number.NEGATIVE_INFINITY
  );
  if (!Number.isFinite(lastActivityAt)) return { kind: 'healthy' };
  const silentForMs = Math.max(0, input.now - lastActivityAt);
  const tools = runningToolTitles(input.activeTurn);
  if (tools.length > 0) {
    return silentForMs >= WAITING_NOTICE_AFTER_MS
      ? { kind: 'waiting-on-tools', silentForMs, tools }
      : { kind: 'healthy' };
  }
  return silentForMs >= STALLED_AFTER_MS ? { kind: 'stalled', silentForMs } : { kind: 'healthy' };
}

type ToolLike = { title?: unknown; status?: unknown; children?: unknown };

/** Titles of the tools still running in the turn, nested calls included. */
export function runningToolTitles(turn: TranscriptTurn | null | undefined): string[] {
  const titles: string[] = [];
  const visit = (items: readonly unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('toolCallId' in item)) continue;
      const tool = item as ToolLike;
      if (tool.status === 'running' && typeof tool.title === 'string' && tool.title.trim()) {
        titles.push(tool.title.trim());
      }
      if (Array.isArray(tool.children)) visit(tool.children);
    }
  };
  visit(turn?.items ?? []);
  return titles;
}

/** The text of the user prompt that opened the turn, for "try again". */
export function turnPromptText(turn: TranscriptTurn | null | undefined): string | null {
  const message = turn?.items.find((item) => item.kind === 'message' && item.role === 'user');
  if (!message || message.kind !== 'message') return null;
  const text = message.text.trim();
  return text ? text : null;
}

/** "12 dk", "2 sa 5 dk" */
export function formatSilence(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} sa` : `${hours} sa ${rest} dk`;
}
