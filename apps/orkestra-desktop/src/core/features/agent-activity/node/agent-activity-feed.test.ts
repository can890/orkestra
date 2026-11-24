import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_MAX_SNAPSHOT_BYTES,
  AGENT_ACTIVITY_PREVIEW_CHARS,
  agentActivityEventSchema,
  agentActivitySnapshotSchema,
  type AgentActivityEntry,
  type AgentActivityEvent,
} from '../api/contract';
import { AgentActivityFeed, fitEntriesToBudget } from './agent-activity-feed';
import type { AgentActivityContext } from './agent-activity-model';

function makeFeed(
  options: { publishing?: boolean; contexts?: Record<string, AgentActivityContext | null> } = {}
) {
  const clock = { now: 1_000_000 };
  const feed = new AgentActivityFeed({
    resolveContext: async ({ conversationId }) =>
      options.contexts && conversationId in options.contexts
        ? options.contexts[conversationId]!
        : {
            projectId: 'p1',
            taskId: `t-${conversationId}`,
            title: `Chat ${conversationId}`,
            projectName: 'Orkestra',
            providerName: 'Codex',
          },
    hostName: () => 'Ornek-Mac',
    now: () => clock.now,
    pruneIntervalMs: 0,
    ...(options.publishing === undefined ? {} : { publishing: options.publishing }),
  });
  const events: AgentActivityEvent[] = [];
  const unsubscribe = feed
    .eventsHost()
    .resolve(undefined)
    .subscribe((update) => {
      events.push(agentActivityEventSchema.parse((update.delta as { event: unknown }).event));
    });
  return { feed, events, clock, unsubscribe };
}

describe('AgentActivityFeed', () => {
  it('serves a schema-valid snapshot and live upsert/remove events in order', async () => {
    const { feed, events, clock } = makeFeed();
    await feed.handleAgentEvent({
      type: 'start',
      conversationId: 'c1',
      providerId: 'codex',
      timestamp: clock.now,
      payload: {},
    });
    clock.now += 5_000;
    await feed.handleAgentEvent({
      type: 'stop',
      conversationId: 'c1',
      timestamp: clock.now,
      payload: { lastAssistantMessage: 'Done: 3 files changed.' },
    });
    await feed.handleAgentEvent({
      type: 'start',
      conversationId: 'c2',
      timestamp: clock.now,
      payload: {},
    });
    await feed.handleStatusChange({ conversationId: 'c2', status: 'idle' });

    expect(events.map((event) => event.type)).toEqual(['upsert', 'upsert', 'upsert', 'remove']);
    expect(events[1]).toMatchObject({
      type: 'upsert',
      alert: true,
      entry: { conversationId: 'c1', state: 'finished', preview: 'Done: 3 files changed.' },
    });

    const snapshot = agentActivitySnapshotSchema.parse(feed.snapshot());
    expect(snapshot).toMatchObject({ publishing: true, hostName: 'Ornek-Mac', revision: 4 });
    expect(snapshot.entries.map((entry) => entry.conversationId)).toEqual(['c1']);
    expect(snapshot.entries[0]).toMatchObject({ title: 'Chat c1', providerName: 'Codex' });
  });

  it('skips conversations without a task/project context', async () => {
    const { feed, events } = makeFeed({ contexts: { orphan: null } });
    await feed.handleAgentEvent({
      type: 'start',
      conversationId: 'orphan',
      timestamp: 1,
      payload: {},
    });
    expect(events).toEqual([]);
    expect(feed.snapshot().entries).toEqual([]);
  });

  it('stops publishing when disabled: empty snapshot, one publishing event, no more updates', async () => {
    const { feed, events, clock } = makeFeed();
    await feed.handleAgentEvent({
      type: 'start',
      conversationId: 'c1',
      timestamp: clock.now,
      payload: {},
    });
    feed.setPublishing(false);
    await feed.handleAgentEvent({
      type: 'stop',
      conversationId: 'c1',
      timestamp: clock.now + 9_000,
      payload: {},
    });
    expect(events.map((event) => event.type)).toEqual(['upsert', 'publishing']);
    expect(events[1]).toMatchObject({ publishing: false });
    expect(feed.snapshot()).toMatchObject({ publishing: false, entries: [] });

    feed.setPublishing(true);
    expect(feed.snapshot().entries).toEqual([
      expect.objectContaining({ conversationId: 'c1', state: 'finished' }),
    ]);
  });

  it('honours the default-off setting passed at startup', () => {
    const { feed } = makeFeed({ publishing: false });
    expect(feed.isPublishing()).toBe(false);
  });

  it('keeps previews bounded and the snapshot under the remote payload budget', async () => {
    const { feed, clock } = makeFeed();
    for (let i = 0; i < 40; i += 1) {
      await feed.handleAgentEvent({
        type: 'stop',
        conversationId: `c${i}`,
        timestamp: clock.now + i * 10_000,
        payload: { lastAssistantMessage: `data:image/png;base64,${'A'.repeat(400_000)}` },
      });
    }
    const snapshot = feed.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    expect(bytes).toBeLessThanOrEqual(AGENT_ACTIVITY_MAX_SNAPSHOT_BYTES);
    for (const entry of snapshot.entries) {
      expect(entry.preview.length).toBeLessThanOrEqual(AGENT_ACTIVITY_PREVIEW_CHARS);
    }
  });

  it('fits an oversized entry list to the byte budget by trimming previews, then dropping the oldest', () => {
    const entry = (i: number): AgentActivityEntry => ({
      conversationId: `c${i}`,
      projectId: 'p',
      taskId: 't',
      state: 'finished',
      title: 'x'.repeat(100),
      projectName: 'y'.repeat(100),
      providerName: 'z',
      preview: 'p'.repeat(200),
      stateChangedAt: i,
      startedAt: null,
      revision: i,
    });
    const base = { publishing: true, hostName: 'h', now: 0, revision: 0 };
    const entries = Array.from({ length: 30 }, (_, i) => entry(i));
    const fitted = fitEntriesToBudget(entries, base, 6_000);
    expect(Buffer.byteLength(JSON.stringify({ ...base, entries: fitted }))).toBeLessThanOrEqual(
      6_000
    );
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(30);
    expect(fitted[0]!.conversationId).toBe('c0');
    expect(fitted.every((item) => item.preview.length <= 80)).toBe(true);
  });
});
