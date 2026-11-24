import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Secret } from '@orkestra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthoringApi, defineWorkflow } from '@core/features/workflows/api/node/authoring';
import { WorkflowEngine, type AgentStepExecutor } from '@core/features/workflows/api/node/engine';
import { WorkflowRunStore } from '@core/features/workflows/api/node/store';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { AutomationWebhookServer } from './webhook-server';

// Kod iş akışı kancaları otomasyonların webhook sunucusunu paylaşır: gerçek bir yerel istekle
// belirteç, HMAC imzası ve teslimat tekrarı denetlenir.
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
  directory = await mkdtemp(join(tmpdir(), 'orkestra-workflow-hooks-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('workflow hooks on the automation webhook server', () => {
  it('starts runs from a local request, refuses bad tokens/signatures and dedupes retries', async () => {
    const store = new Map<string, Secret<string>>();
    const secrets: SecretStore = {
      getSecret: async (key) => store.get(key) ?? null,
      setSecret: async (key, value) => {
        store.set(key, value);
      },
      deleteSecret: async (key) => {
        store.delete(key);
      },
    };
    const server = new AutomationWebhookServer({
      secrets,
      triggerAutomation: async () => ({ ok: false, status: 404, error: 'no' }),
    });
    const bodies: string[] = [];
    const definition = O.workflow(
      'on-push',
      {
        version: 1,
        payload: O.WebhookRequest,
        triggers: [
          O.webhook('github', { signature: { header: 'X-Hub-Signature-256', prefix: 'sha256=' } }),
        ],
      },
      async (request) => {
        bodies.push((request as { body: string }).body);
      }
    );
    const engine = new WorkflowEngine({
      store: new WorkflowRunStore(directory),
      agents: noAgents,
      logger,
      autoTick: false,
    });
    engine.setDefinitions([{ definition, file: 'x.ts' }]);
    await engine.start();
    server.setWorkflowHookHandler((input) => engine.handleWebhook(input));
    try {
      const url = await server.getWorkflowHookUrl('on-push', 'github');
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/workflow-hook\/on-push\/github\/[0-9a-f]+$/);
      const token = url.split('/').at(-1)!;
      const body = JSON.stringify({ ref: 'refs/heads/main' });
      const sign = (text: string) =>
        `sha256=${createHmac('sha256', token).update(text).digest('hex')}`;
      const post = (target: string, headers: Record<string, string>, text = body) =>
        fetch(target, { method: 'POST', headers, body: text });

      expect((await post(url.replace(/[0-9a-f]+$/, 'wrong'), {})).status).toBe(404);
      expect((await post(url, { 'x-hub-signature-256': 'sha256=00' })).status).toBe(401);

      const headers = { 'x-hub-signature-256': sign(body), 'x-github-delivery': 'd-1' };
      const first = await post(url, headers);
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { runId: string };
      const retry = await post(url, headers);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { runId: string; duplicate: boolean }).runId).toBe(
        firstBody.runId
      );
      await engine.settled(firstBody.runId);
      expect(engine.listRuns()).toHaveLength(1);
      expect(bodies).toEqual([body]);
      expect(engine.getRun(firstBody.runId)!.payload).toMatchObject({
        method: 'POST',
        headers: { 'x-github-delivery': 'd-1' },
      });
    } finally {
      server.setWorkflowHookHandler(null);
      await server.dispose();
      await engine.dispose();
    }
  });
});
