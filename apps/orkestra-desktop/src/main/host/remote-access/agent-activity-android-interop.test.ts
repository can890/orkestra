import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Secret } from '@orkestra/shared';
import { noopLogger } from '@orkestra/shared/logger';
import { describe, expect, it } from 'vitest';
import { AgentActivityFeed } from '@core/features/agent-activity/node/agent-activity-feed';
import { createAgentActivityWireController } from '@core/features/agent-activity/node/wire-controller';
import { parsePairingPayload } from '@core/features/remote-access/api/pairing-payload';
import {
  RemoteAccessService,
  type StoredRemoteAccessState,
} from '@core/features/remote-access/node/remote-access-service';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

// Diller arası uçtan uca test (isteğe bağlı): gerçek TCP üzerinde gerçek uzak erişim sunucusu +
// ajan etkinliği akışı başlatır ve Android projesindeki Java istemcisini (HostLink, kendi
// WebSocket + kripto uygulaması) JVM birim testi olarak buna bağlar. Android SDK/Gradle gerektirir;
// yalnızca `ORKESTRA_ANDROID_INTEROP=1` ile çalışır (CI'da ve olağan koşuda atlanır).

const enabled = process.env.ORKESTRA_ANDROID_INTEROP === '1';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, Secret<string>>();
  async getSecret(key: string) {
    return this.values.get(key) ?? null;
  }
  async setSecret(key: string, value: Secret<string>) {
    this.values.set(key, value);
  }
  async deleteSecret(key: string) {
    this.values.delete(key);
  }
}

const androidDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../orkestra-mobile/android'
);

function runGradle(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      './gradlew',
      [
        ':app:testDebugUnitTest',
        '--offline',
        '--no-daemon',
        '--rerun',
        '--tests',
        'app.orkestra.mobile.agentnotify.HostLinkInteropTest',
      ],
      { cwd: androidDir, env }
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!enabled)('Android HostLink ↔ desktop remote server interop', () => {
  it('the Java background client receives snapshot and live alerts over real TCP', async () => {
    let persisted: StoredRemoteAccessState | null = null;
    const feed = new AgentActivityFeed({
      resolveContext: async ({ conversationId }) => ({
        projectId: 'p1',
        taskId: 't1',
        title: `Chat ${conversationId}`,
        projectName: 'Orkestra',
        providerName: 'Claude',
      }),
      hostName: () => 'Interop-Mac',
      pruneIntervalMs: 0,
    });
    const service = new RemoteAccessService({
      persistence: {
        load: async () => (persisted ? structuredClone(persisted) : null),
        save: async (state) => {
          persisted = structuredClone(state);
        },
      },
      secrets: new MemorySecrets(),
      logger: noopLogger,
      hostName: () => 'Interop-Mac',
      networkInterfaces: () => ({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: false }],
      }),
      isSecureStorageAvailable: () => true,
      bindHost: '127.0.0.1',
      pickPort: () => 0,
    });
    service.attachAgentActivity({
      controller: createAgentActivityWireController(feed),
      setPublishing: (value) => feed.setPublishing(value),
      dispose: () => feed.dispose(),
    });
    await service.start({});
    const enabledResult = await service.setEnabled(true);
    if (!enabledResult.success) throw new Error(enabledResult.error.message);
    const pairing = await service.createPairing();
    if (!pairing.success) throw new Error(pairing.error.message);
    const payload = parsePairingPayload(pairing.data.payload)!;
    const port = (await service.getState()).port!;

    await feed.handleAgentEvent({
      type: 'start',
      conversationId: 'seed-conversation',
      timestamp: Date.now(),
      payload: {},
    });
    // Java istemcisi bağlanıp abone olduktan sonra en az bir "bitti" geçişini görsün diye
    // her saniye yeni bir tur sonucu yayınla.
    let turn = 0;
    const ticker = setInterval(() => {
      turn += 1;
      void feed.handleAgentEvent({
        type: turn % 2 === 1 ? 'stop' : 'start',
        conversationId: 'live-conversation',
        timestamp: Date.now(),
        payload: { lastAssistantMessage: `turn ${turn}` },
      });
    }, 1_000);

    try {
      const result = await runGradle({
        ...process.env,
        ANDROID_HOME: process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Library/Android/sdk'),
        ORKESTRA_INTEROP_CONFIG: JSON.stringify({
          hostId: payload.h,
          address: '127.0.0.1',
          port,
          deviceId: payload.d,
          secret: payload.s,
        }),
      });
      expect(result.code, result.output.slice(-4_000)).toBe(0);
      const report = path.join(
        androidDir,
        'app/build/test-results/testDebugUnitTest/TEST-app.orkestra.mobile.agentnotify.HostLinkInteropTest.xml'
      );
      expect(existsSync(report)).toBe(true);
      const xml = readFileSync(report, 'utf8');
      // Atlanmadı ve geçti: sunucu gerçekten konuşuldu.
      expect(xml).toMatch(/tests="1" skipped="0" failures="0" errors="0"/);
      const state = await service.getState();
      expect(state.devices[0]?.status).toBe('paired');
    } finally {
      clearInterval(ticker);
      await service.dispose();
    }
  }, 600_000);
});
