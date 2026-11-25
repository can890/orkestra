import type { TranscriptTurn } from '@orkestra/core/runtimes/acp/api/client';
import { describe, expect, it } from 'vitest';
import {
  STALLED_AFTER_MS,
  WAITING_NOTICE_AFTER_MS,
  assessTurnLiveness,
  formatSilence,
  runningToolTitles,
  turnPromptText,
} from './turn-liveness';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function turn(items: unknown[]): TranscriptTurn {
  return { id: 't', seq: 2, initiator: 'user', items } as TranscriptTurn;
}

const user = { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'cevap versene' };
const runningTool = (title: string, extra: object = {}) => ({
  kind: 'execute-tool-call',
  id: title,
  seq: 1,
  toolCallId: title,
  title,
  status: 'running',
  ...extra,
});

describe('assessTurnLiveness', () => {
  it('describes a turn that only waits on a long-running tool, without calling it stuck', () => {
    // The observed case: the agent said "waiting for the frames" and went quiet for hours while
    // its background job still ran; the chat showed "Çalışıyor…" and nothing else.
    const activeTurn = turn([user, runningTool('uret_sahneler.sh')]);
    const activity = { turnStartedAt: T0, lastActivityAt: T0 + 3 * MIN };
    const at = (ms: number) =>
      assessTurnLiveness({
        isWorking: true,
        activity,
        observedActivityAt: null,
        activeTurn,
        now: activity.lastActivityAt + ms,
      });
    expect(at(WAITING_NOTICE_AFTER_MS - 1).kind).toBe('healthy');
    expect(at(2 * 60 * MIN)).toEqual({
      kind: 'waiting-on-tools',
      silentForMs: 2 * 60 * MIN,
      tools: ['uret_sahneler.sh'],
    });
  });

  it('reports a silent turn with no running tool as stalled', () => {
    const input = {
      isWorking: true,
      activity: { turnStartedAt: T0, lastActivityAt: T0 },
      observedActivityAt: null,
      activeTurn: turn([user, { ...runningTool('done'), status: 'done' }]),
    };
    expect(assessTurnLiveness({ ...input, now: T0 + STALLED_AFTER_MS - 1 }).kind).toBe('healthy');
    expect(assessTurnLiveness({ ...input, now: T0 + STALLED_AFTER_MS })).toEqual({
      kind: 'stalled',
      silentForMs: STALLED_AFTER_MS,
    });
  });

  it('uses the newest of runtime and locally observed activity, and the local one alone', () => {
    const base = { isWorking: true, activeTurn: turn([user]), now: T0 + 20 * MIN };
    expect(
      assessTurnLiveness({
        ...base,
        activity: { turnStartedAt: T0, lastActivityAt: T0 },
        observedActivityAt: T0 + 19 * MIN,
      }).kind
    ).toBe('healthy');
    // An older workspace server without `activity`: the client-observed clock still works.
    expect(assessTurnLiveness({ ...base, observedActivityAt: T0 }).kind).toBe('stalled');
    expect(assessTurnLiveness({ ...base, observedActivityAt: null }).kind).toBe('healthy');
  });

  it('is healthy whenever nothing is working', () => {
    expect(
      assessTurnLiveness({
        isWorking: false,
        activity: { turnStartedAt: T0, lastActivityAt: T0 },
        observedActivityAt: null,
        activeTurn: turn([user]),
        now: T0 + 999 * MIN,
      }).kind
    ).toBe('healthy');
  });
});

describe('turn helpers', () => {
  it('finds nested running tools and the prompt text', () => {
    const activeTurn = turn([
      user,
      {
        ...runningTool('group', { status: 'done' }),
        children: [runningTool('gflow image')],
      },
    ]);
    expect(runningToolTitles(activeTurn)).toEqual(['gflow image']);
    expect(turnPromptText(activeTurn)).toBe('cevap versene');
    expect(turnPromptText(null)).toBeNull();
  });

  it('formats durations in Turkish units', () => {
    expect(formatSilence(30_000)).toBe('1 dk');
    expect(formatSilence(12 * MIN)).toBe('12 dk');
    expect(formatSilence(120 * MIN)).toBe('2 sa');
    expect(formatSilence(135 * MIN)).toBe('2 sa 15 dk');
  });
});
