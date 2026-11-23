import { secret, type Secret } from '@orkestra/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { AutomationWebhookServer, WEBHOOK_MAX_BODY_BYTES } from './webhook-server';

function createMemorySecretStore(): SecretStore {
  const map = new Map<string, Secret<string>>();
  return {
    getSecret: async (key) => map.get(key) ?? null,
    setSecret: async (key, val) => {
      map.set(key, val);
    },
    deleteSecret: async (key) => {
      map.delete(key);
    },
  };
}

describe('AutomationWebhookServer', () => {
  const servers: AutomationWebhookServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.dispose();
    }
  });

  it('rejects missing/wrong bearer token (401), accepts valid token (202), and caps payload > 64KB (413)', async () => {
    const secrets = createMemorySecretStore();
    await secrets.setSecret('automation.webhookSecret.auto-1', secret('tok-secret-123', 'key'));

    const triggerAutomation = vi.fn(async () => ({ ok: true as const, runId: 'run-9' }));
    const server = new AutomationWebhookServer({ secrets, triggerAutomation });
    servers.push(server);

    const info = await server.getWebhookInfo('auto-1');
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook\/auto-1$/);
    expect(info.curlSnippet).toContain('tok-secret-123');

    // 401 unauthorized
    const badRes = await fetch(info.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: '{}',
    });
    expect(badRes.status).toBe(401);

    // 202 accepted
    const okRes = await fetch(info.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok-secret-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'deploy' }),
    });
    expect(okRes.status).toBe(202);
    expect(triggerAutomation).toHaveBeenCalledWith({
      automationId: 'auto-1',
      payload: { event: 'deploy' },
    });

    // 413 payload too large
    const bigRes = await fetch(info.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-secret-123' },
      body: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 256),
    });
    expect(bigRes.status).toBe(413);
  });
});
