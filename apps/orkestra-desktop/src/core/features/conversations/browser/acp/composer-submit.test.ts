import { describe, expect, it } from 'vitest';
import {
  composerSubmitRoute,
  HOLD_REASON_HOST,
  HOLD_REASON_SESSION,
  workingTurnPlacement,
  type ComposerSubmitInput,
} from './composer-submit';

const live: ComposerSubmitInput = {
  hostDisabled: false,
  hasSession: true,
  sessionUsable: true,
  connecting: false,
  loadError: null,
};

describe('workingTurnPlacement', () => {
  it('steers only into an agent that advertises steering (Claude Code, Codex, Antigravity)', () => {
    expect(workingTurnPlacement('steer-cancel', true)).toBe('steer');
  });

  it('queues for agents without mid-turn input, so an older host never stops their turn', () => {
    // Grok, Kimi, GLM, custom ACP agents: the old host answered `steer` with cancel-and-resend.
    expect(workingTurnPlacement('steer-cancel', false)).toBe('queue');
  });

  it('honours the "queue" setting for every agent', () => {
    expect(workingTurnPlacement('queue', true)).toBe('queue');
    expect(workingTurnPlacement('queue', false)).toBe('queue');
  });
});

describe('composerSubmitRoute', () => {
  it('sends while the live session is usable', () => {
    expect(composerSubmitRoute(live)).toEqual({ kind: 'send' });
  });

  it('waits for the connection while the session starts or reconnects', () => {
    expect(composerSubmitRoute({ ...live, sessionUsable: false })).toEqual({ kind: 'wait' });
    expect(
      composerSubmitRoute({ ...live, hasSession: false, sessionUsable: false, connecting: true })
    ).toEqual({ kind: 'wait' });
  });

  it('holds the draft with a reason when the project host is offline', () => {
    expect(composerSubmitRoute({ ...live, hostDisabled: true })).toEqual({
      kind: 'hold',
      reason: HOLD_REASON_HOST,
    });
  });

  it('holds the draft with a reason when the session could not be loaded', () => {
    expect(
      composerSubmitRoute({
        ...live,
        hasSession: false,
        sessionUsable: false,
        loadError: { kind: 'session_not_found', message: 'gone' },
      })
    ).toEqual({ kind: 'hold', reason: HOLD_REASON_SESSION });
    expect(composerSubmitRoute({ ...live, hasSession: false, sessionUsable: false })).toEqual({
      kind: 'hold',
      reason: HOLD_REASON_SESSION,
    });
  });
});
