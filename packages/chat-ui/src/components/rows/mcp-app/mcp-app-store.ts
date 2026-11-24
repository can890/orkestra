import {
  MCP_APP_DEFAULT_HEIGHT,
  clampMcpAppHeight,
  type McpAppConsentRequest,
} from '@orkestra/core/runtimes/acp/api/client';
import { createSignal, type Accessor, type Setter } from 'solid-js';
import type { ChatMcpAppView } from '@/commands';

/**
 * Per-row MCP app state, keyed by row id (item ids are unique across conversations). The unit's
 * `measure()` reads these signals, so resolving the app, a new reported height or a consent prompt
 * re-measures the row and the transcript below moves with it.
 */
export type McpAppPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'ready'; view: ChatMcpAppView };

export type McpAppConsent = {
  request: McpAppConsentRequest;
  settle: (approved: boolean) => void;
};

type Entry = {
  phase: [Accessor<McpAppPhase>, Setter<McpAppPhase>];
  height: [Accessor<number>, Setter<number>];
  consent: [Accessor<McpAppConsent | null>, Setter<McpAppConsent | null>];
};

const entries = new Map<string, Entry>();

function entry(id: string): Entry {
  let current = entries.get(id);
  if (!current) {
    current = {
      phase: createSignal<McpAppPhase>({ kind: 'idle' }),
      height: createSignal(MCP_APP_DEFAULT_HEIGHT),
      consent: createSignal<McpAppConsent | null>(null),
    };
    entries.set(id, current);
  }
  return current;
}

export function mcpAppPhase(id: string): Accessor<McpAppPhase> {
  return entry(id).phase[0];
}

export function setMcpAppPhase(id: string, phase: McpAppPhase): void {
  entry(id).phase[1](phase);
}

export function mcpAppHeight(id: string): Accessor<number> {
  return entry(id).height[0];
}

export function setMcpAppHeight(id: string, height: number): void {
  entry(id).height[1](clampMcpAppHeight(height));
}

export function mcpAppConsent(id: string): Accessor<McpAppConsent | null> {
  return entry(id).consent[0];
}

export function setMcpAppConsent(id: string, consent: McpAppConsent | null): void {
  entry(id).consent[1](() => consent);
}

/** Card border (2) + header (28). */
export const MCP_APP_CHROME_H = 30;
/** Minimum frame height while a consent prompt covers it. */
export const MCP_APP_CONSENT_MIN_H = 200;
/** Space above and below a visible app (the unit has no static margin, so empty rows stay 0). */
export const MCP_APP_GAP = 8;

/** Row height: zero until the app resolves, so calls without an app keep today's layout. */
export function mcpAppRowHeight(id: string): number {
  const phase = mcpAppPhase(id)();
  if (phase.kind !== 'ready') return 0;
  const frame = mcpAppConsent(id)()
    ? Math.max(mcpAppHeight(id)(), MCP_APP_CONSENT_MIN_H)
    : mcpAppHeight(id)();
  return MCP_APP_GAP * 2 + MCP_APP_CHROME_H + frame;
}
