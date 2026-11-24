import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthoringApi, defineWorkflow } from './authoring';
import { WorkflowEngine, type AgentStepExecutor } from './engine';
import { WorkflowRunStore } from './store';
import {
  HookRateLimiter,
  isMissedRun,
  nextScheduledAt,
  verifyWebhookSignature,
  webhookDeliveryKey,
} from './triggers';

const O = createAuthoringApi(defineWorkflow);
const logger = { info: () => undefined, warn: () => undefined };
const noAgents: AgentStepExecutor = {
  run: async () => ({
    status: 'failed',
    message: 'none',
    started: false,
    retryable: false,
    conversationId: null,
  }),
  followUp: async () => ({
    status: 'failed',
    message: 'none',
    started: false,
    retryable: false,
    conversationId: null,
  }),
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orkestra-workflow-triggers-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('schedules', () => {
  it('computes the next interval, daily and cron times', () => {
    const from = new Date(2026, 0, 5, 8, 30, 0).getTime(); // Pazartesi 08:30 (yerel)
    expect(nextScheduledAt(O.every('1 hour').schedule, from)).toBe(from + 3_600_000);
    expect(nextScheduledAt(O.daily('09:00').schedule, from)).toBe(
      new Date(2026, 0, 5, 9, 0, 0).getTime()
    );
    // Hafta içi 08:00 geçti: ertesi gün.
    expect(nextScheduledAt(O.daily('08:00', { weekdays: [1, 2, 3, 4, 5] }).schedule, from)).toBe(
      new Date(2026, 0, 6, 8, 0, 0).getTime()
    );
    // Yalnızca pazar: sonraki pazar.
    expect(nextScheduledAt(O.daily('08:00', { weekdays: [0] }).schedule, from)).toBe(
      new Date(2026, 0, 11, 8, 0, 0).getTime()
    );
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(nextScheduledAt(O.cron('0 9 * * *', { tz }).schedule, from)).toBe(
      new Date(2026, 0, 5, 9, 0, 0).getTime()
    );
  });

  it('refuses bad schedules and skips daily times missed by more than 10 minutes', () => {
    expect(() => O.every('30 seconds')).toThrow(/one minute/);
    expect(() => O.daily('25:00')).toThrow(/24-hour/);
    expect(() => O.cron('not a cron')).toThrow(/five-field/);
    const daily = O.daily('09:00').schedule;
    expect(isMissedRun(daily, 0, 5 * 60_000)).toBe(false);
    expect(isMissedRun(daily, 0, 11 * 60_000)).toBe(true);
    expect(isMissedRun(O.every('1 hour').schedule, 0, 10 * 3_600_000)).toBe(false);
  });

  it('starts a scheduled run one interval after load and collapses downtime', async () => {
    let now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const payloads: unknown[] = [];
    const definition = O.workflow(
      'hourly',
      { version: 1, payload: O.Tick, triggers: [O.every('1 hour')] },
      async (tick) => {
        payloads.push(tick);
        return null;
      }
    );
    const engine = new WorkflowEngine({
      store: new WorkflowRunStore(directory),
      agents: noAgents,
      logger,
      autoTick: false,
      now: () => now,
    });
    engine.setDefinitions([{ definition, file: 'x.ts' }]);
    await engine.start();
    await engine.tick();
    expect(engine.listRuns()).toHaveLength(0);
    expect(engine.nextScheduleAt('hourly', 'every:3600000')).toBe(now + 3_600_000);

    now += 5 * 3_600_000; // Uygulama 5 saat kapalı kaldı.
    await engine.tick();
    const runs = engine.listRuns();
    expect(runs).toHaveLength(1);
    await engine.settled(runs[0]!.id);
    expect(payloads).toEqual([{ scheduledAt: new Date(Date.UTC(2026, 0, 5, 9)).toISOString() }]);
    expect(engine.getRun(runs[0]!.id)!.trigger).toEqual({
      kind: 'schedule',
      detail: 'every:3600000',
    });
    expect(engine.nextScheduleAt('hourly', 'every:3600000')).toBe(now + 3_600_000);
    await engine.tick();
    expect(engine.listRuns()).toHaveLength(1);
    await engine.dispose();
  });
});

describe('polled issue triggers', () => {
  it('only starts runs for issues opened after the workflow first loaded', async () => {
    let issues = [
      {
        provider: 'github',
        identifier: '1',
        displayIdentifier: '#1',
        title: 'old',
        url: 'u1',
        project: 'p',
      },
    ];
    const titles: string[] = [];
    const definition = O.workflow(
      'triage',
      { version: 1, payload: O.Issue, triggers: [O.issues.opened({ project: 'p' })] },
      async (issue) => {
        titles.push((issue as { title: string }).title);
      }
    );
    const engine = new WorkflowEngine({
      store: new WorkflowRunStore(directory),
      agents: noAgents,
      logger,
      autoTick: false,
      pollSources: { issues: async () => issues, pullRequests: async () => [] },
    });
    engine.setDefinitions([{ definition, file: 'x.ts' }]);
    await engine.start();
    await engine.poll();
    expect(engine.listRuns()).toHaveLength(0);
    issues = [
      {
        provider: 'github',
        identifier: '2',
        displayIdentifier: '#2',
        title: 'new',
        url: 'u2',
        project: 'p',
      },
      ...issues,
    ];
    await engine.poll();
    await engine.poll();
    const runs = engine.listRuns();
    expect(runs).toHaveLength(1);
    await engine.settled(runs[0]!.id);
    expect(titles).toEqual(['new']);
    expect(runs[0]!.trigger.kind).toBe('issue');
    await engine.dispose();
  });
});

describe('webhooks', () => {
  it('verifies HMAC signatures and derives delivery keys', () => {
    const body = '{"action":"opened"}';
    const tag = createHmac('sha256', 'shh').update(body).digest('hex');
    const signature = {
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
      encoding: 'hex' as const,
    };
    expect(
      verifyWebhookSignature({
        signature,
        secret: 'shh',
        body,
        headers: { 'x-hub-signature-256': `sha256=${tag}` },
      })
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        signature,
        secret: 'other',
        body,
        headers: { 'x-hub-signature-256': `sha256=${tag}` },
      })
    ).toBe(false);
    expect(verifyWebhookSignature({ signature, secret: 'shh', body, headers: {} })).toBe(false);
    const request = { method: 'POST', headers: { 'x-github-delivery': 'abc' }, query: '', body };
    expect(webhookDeliveryKey(request, undefined)).toMatch(/^x-github-delivery:/);
    expect(webhookDeliveryKey(request, () => 'mine')).toMatch(/^key:/);
    expect(webhookDeliveryKey({ ...request, headers: {} }, undefined)).toBeNull();
  });

  it('limits a hook to its runs per minute', () => {
    const limiter = new HookRateLimiter(2, 60_000);
    expect(limiter.take('h', 0)).toBe(true);
    expect(limiter.take('h', 1)).toBe(true);
    expect(limiter.take('h', 2)).toBe(false);
    expect(limiter.take('h', 60_001)).toBe(true);
  });
});
