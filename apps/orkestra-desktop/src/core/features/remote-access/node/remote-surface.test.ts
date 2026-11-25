import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WireError, type Controller } from '@orkestra/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import { agentActivityContract } from '@core/features/agent-activity/api/contract';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import {
  createRemoteNotificationsSurfaceController,
  createRemoteSurfaceController,
  isRemoteProcedureAllowed,
  isRemoteTopicAllowed,
  REMOTE_ALLOWED_PROCEDURES,
  REMOTE_ALLOWED_TOPICS,
  REMOTE_NOTIFICATIONS_PROCEDURES,
  REMOTE_NOTIFICATIONS_TOPICS,
  REMOTE_ONLY_PROCEDURES,
  REMOTE_ONLY_TOPICS,
} from './remote-surface';

type Surface = { procedures: Set<string>; topics: Set<string> };

const ENDPOINT_KINDS = new Set([
  'procedure',
  'downloadFile',
  'uploadFile',
  'liveJob',
  'liveLog',
  'eventStream',
  'liveModel',
]);

/** Gerçek masaüstü sözleşmesindeki tüm yordam yolları ve canlı konular. */
function enumerateSurface(): Surface {
  const surface: Surface = { procedures: new Set(), topics: new Set() };
  const walk = (node: unknown, prefix: string[]): void => {
    if (typeof node !== 'object' || node === null) return;
    for (const [name, def] of Object.entries(node as Record<string, unknown>)) {
      const path = [...prefix, name];
      const joined = path.join('.');
      const kind = (def as { kind?: string } | null)?.kind;
      if (kind && ENDPOINT_KINDS.has(kind)) {
        const endpoint = def as {
          states?: Record<string, unknown>;
          mutations?: Record<string, unknown>;
        };
        switch (kind) {
          case 'procedure':
          case 'downloadFile':
          case 'uploadFile':
            surface.procedures.add(joined);
            break;
          case 'liveJob':
            surface.topics.add(joined);
            surface.procedures.add(`${joined}.start`);
            surface.procedures.add(`${joined}.cancel`);
            break;
          case 'liveLog':
          case 'eventStream':
            surface.topics.add(joined);
            break;
          case 'liveModel':
            for (const state of Object.keys(endpoint.states ?? {})) {
              surface.topics.add(`${joined}.${state}`);
            }
            for (const mutation of Object.keys(endpoint.mutations ?? {})) {
              surface.procedures.add(`${joined}.${mutation}`);
            }
            break;
        }
      } else {
        walk(def, path);
      }
    }
  };
  walk(desktopDomainContracts, []);
  return surface;
}

function spyController(): Controller {
  return {
    call: vi.fn(async () => 'called'),
    resolveLive: vi.fn(() => ({ snapshot: vi.fn(), subscribe: vi.fn() })),
    acquireLive: vi.fn(() => ({ ready: vi.fn(), release: vi.fn() })),
  } as unknown as Controller;
}

function allDomainSpies(): Record<string, Controller> {
  return Object.fromEntries(Object.keys(desktopDomainContracts).map((k) => [k, spyController()]));
}

const FORBIDDEN_DOMAINS = [
  'account',
  'appSettings',
  'devPerf',
  'editor',
  'files',
  'github',
  'host',
  'hostMaintenance',
  'hosts',
  'integrations',
  'issues',
  'legacyPort',
  'logging',
  'logHealth',
  'machines',
  'mcp',
  'outsideAgents',
  'previewServers',
  'projectSettings',
  'projectWorkspaces',
  'promptLibrary',
  'pullRequests',
  'remoteAccess',
  'repository',
  'search',
  'skills',
  'ssh',
  'telemetry',
  'terminals',
  'updates',
  'voice',
  'workspaceRegistry',
  'workspaces',
  'lifecycleScripts',
  'automations',
  'browser',
  'catalog',
];
const ALLOWED_DOMAINS = new Set([
  'agents',
  'conversations',
  'mementos',
  'notifications',
  'projects',
  'sourceControl',
  'tasks',
  'usageLimits',
]);

describe('remote surface allowlist', () => {
  const real = enumerateSurface();

  it('restricts remote PR review writes to workspace, file revision and account', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    const path = 'sourceControl.review.setViewed';
    const input = {
      workspaceId: 'workspace',
      url: 'https://github.com/org/repo/pull/1',
      path: 'src/index.ts',
      revision: 'revision',
      viewed: true,
      account: 'a'.repeat(64),
    };
    await expect(surface.call(path, input)).resolves.toBe('called');
    await expect(surface.call(path, { ...input, headRefOid: 'untrusted' })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    await expect(surface.call(path, { ...input, account: 'wrong' })).rejects.toMatchObject({
      code: 'CONTRACT_MISMATCH',
    });
    await expect(
      createRemoteNotificationsSurfaceController(controllers).call(path, input)
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROCEDURE' });
  });

  it('only lists endpoints that exist in the desktop contract (renames break loudly)', () => {
    for (const path of Object.keys(REMOTE_ALLOWED_PROCEDURES)) {
      expect(real.procedures.has(path), `procedure ${path}`).toBe(true);
    }
    for (const topic of REMOTE_ALLOWED_TOPICS) {
      expect(real.topics.has(topic), `topic ${topic}`).toBe(true);
    }
  });

  it('never exposes a sensitive domain', () => {
    const entries = [...Object.keys(REMOTE_ALLOWED_PROCEDURES), ...REMOTE_ALLOWED_TOPICS];
    for (const entry of entries) {
      const domain = entry.split('.')[0]!;
      expect(ALLOWED_DOMAINS.has(domain), `${entry} is in an unlisted domain`).toBe(true);
      expect(FORBIDDEN_DOMAINS).not.toContain(domain);
    }
  });

  it('exposes only the two narrowly scoped snooze memento procedures', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    const patch = { projectId: 'p1', taskId: 't1', durationMs: 1_800_000 };
    vi.mocked(controllers.conversations!.call).mockResolvedValueOnce([{ id: 'c1' }]);
    await expect(surface.call('mementos.patchSidebarSnooze', patch)).resolves.toBe('called');
    await expect(surface.call('mementos.getSidebarSnoozes', undefined)).resolves.toBe('called');
    await expect(
      surface.call('mementos.patchSidebarSnooze', { ...patch, durationMs: 1 })
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    await expect(surface.call('mementos.deleteAll', undefined)).rejects.toMatchObject({
      code: 'UNKNOWN_PROCEDURE',
    });
    expect(surface.resolveLive('mementos.memento.value')).toBeNull();
  });

  it('keeps risky members of allowed domains out', () => {
    const entries = [...Object.keys(REMOTE_ALLOWED_PROCEDURES), ...REMOTE_ALLOWED_TOPICS];
    const risky = [
      /terminals?/i,
      /mcp/i,
      /\.tui\./,
      /attachments/,
      /startLogin|sendLoginInput|loginOutput|cancelLogin|markUrlHandled/,
      // deleteQueuedPrompt yalnızca henüz gönderilmemiş sıradaki bir mesajı kaldırır.
      /\.(delete(?!QueuedPrompt$)|install|update|uninstall|rename|setStatus|archive)/,
      /exportRawAcpLog|exportAcpTranscript|terminate|switchView/,
      /getSettings|updateSettings|resolveInstallation/,
      /commit|push|pull|publish|stage|unstage|revert|applyHunk|mergeLocalBranch|renameCurrentBranch/i,
    ];
    for (const entry of entries) {
      for (const pattern of risky)
        expect(entry, `${entry} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it('rejects every endpoint of the real contract that is not allowlisted, without touching it', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);

    let deniedProcedures = 0;
    for (const path of real.procedures) {
      if (isRemoteProcedureAllowed(path)) continue;
      deniedProcedures += 1;
      await expect(surface.call(path, {}), path).rejects.toMatchObject({
        code: 'UNKNOWN_PROCEDURE',
      });
    }
    let deniedTopics = 0;
    for (const topic of real.topics) {
      if (REMOTE_ALLOWED_TOPICS.has(topic)) continue;
      deniedTopics += 1;
      expect(surface.resolveLive(topic), topic).toBeNull();
      expect(surface.acquireLive(topic), topic).toBeNull();
    }
    // Savunma: izin listesi dışında ÇOK daha fazla uç nokta var ve hiçbiri alta ulaşmadı.
    expect(deniedProcedures).toBeGreaterThan(200);
    expect(deniedTopics).toBeGreaterThan(20);
    for (const controller of Object.values(controllers)) {
      expect(controller.call).not.toHaveBeenCalled();
      expect(controller.resolveLive).not.toHaveBeenCalled();
      expect(controller.acquireLive).not.toHaveBeenCalled();
    }
  });

  it('denies unknown paths, prototype keys, upload attempts and malformed topics by default', async () => {
    const surface = createRemoteSurfaceController(allDomainSpies());
    for (const path of [
      '',
      'ssh',
      'constructor',
      '__proto__',
      'toString',
      'conversations.',
      'a.b',
    ]) {
      await expect(surface.call(path, {})).rejects.toBeInstanceOf(WireError);
    }
    await expect(
      surface.call('conversations.getConversations', undefined, {
        uploadFile: {} as never,
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_PROCEDURE' });
    for (const topic of ['', '|', 'projects', 'projects.projectList.list2', 'ssh.state|{}']) {
      expect(surface.resolveLive(topic)).toBeNull();
    }
    // Anahtar kısmı, konu kimliğini taklit edemez.
    expect(isRemoteTopicAllowed('ssh.connections|projects.projectList.list')).toBe(false);
    expect(isRemoteTopicAllowed('projects.projectList.list|{"x":1}')).toBe(true);
  });

  it('routes allowed calls and topics to the owning domain controller', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    await expect(surface.call('usageLimits.get', { x: 1 })).resolves.toBe('called');
    expect(controllers.usageLimits!.call).toHaveBeenCalledWith('get', { x: 1 }, undefined);
    surface.resolveLive('conversations.acp.session.state|{"conversationId":"c"}');
    expect(controllers.conversations!.resolveLive).toHaveBeenCalledWith(
      'acp.session.state|{"conversationId":"c"}'
    );
    surface.acquireLive('tasks.taskList.list|{"projectId":"p"}');
    expect(controllers.tasks!.acquireLive).toHaveBeenCalledWith('taskList.list|{"projectId":"p"}');
    // Eksik alan denetleyicisi: reddedilir, çökmez.
    const partial = createRemoteSurfaceController({});
    await expect(partial.call('usageLimits.get', {})).rejects.toMatchObject({
      code: 'UNKNOWN_PROCEDURE',
    });
    expect(partial.resolveLive('projects.projectList.list')).toBeNull();
  });

  it('restricts prompts: no hidden context, attachments or oversized text', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    const base = {
      conversationId: 'c1',
      promptId: '3b241101-e2bb-4255-8caf-4136c566a962',
      prompt: { text: 'merhaba' },
    };
    await expect(surface.call('conversations.acp.sendPrompt', base)).resolves.toBe('called');
    // Telefon çalışan tura her zaman canlı yönlendirme (steer) ile yazar.
    await expect(
      surface.call('conversations.acp.sendPrompt', { ...base, placement: 'steer' })
    ).resolves.toBe('called');
    for (const bad of [
      { ...base, prompt: { text: 'x', hiddenContext: 'gizli' } },
      { ...base, prompt: { text: 'x', attachments: [{ path: '/etc/passwd' }] } },
      { ...base, prompt: { text: 'x'.repeat(100_001) } },
      { ...base, prompt: { text: '' } },
      { ...base, prompt: { text: 'x', extra: true } },
      { ...base, promptId: 'not-a-uuid' },
      { ...base, placement: 'interrupt' },
      null,
    ]) {
      await expect(surface.call('conversations.acp.sendPrompt', bad)).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }
    await expect(
      surface.call('conversations.acp.loadHistory', { conversationId: 'c', limit: 500 })
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    await expect(
      surface.call('conversations.acp.loadHistory', { conversationId: 'c', limit: 50 })
    ).resolves.toBe('called');
    await expect(
      surface.call('conversations.acp.resolvePermission', { conversationId: 'c' })
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('validates and uploads mobile images once when a prompt is retried', async () => {
    const controllers = allDomainSpies();
    const call = vi.fn(async (path: string) =>
      path === 'attachments.upload'
        ? { success: true, data: { id: 'stored-image' } }
        : { success: true, data: { queued: false } }
    );
    controllers.conversations!.call = call;
    const surface = createRemoteSurfaceController(controllers);
    const input = {
      conversationId: 'c1',
      promptId: '3b241101-e2bb-4255-8caf-4136c566a962',
      prompt: {
        text: '',
        mobileDelivery: true,
        mobileImages: [{ name: 'shot.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      },
    };

    await expect(
      surface.call('conversations.acp.sendPrompt', {
        ...input,
        prompt: {
          ...input.prompt,
          mobileImages: [{ ...input.prompt.mobileImages[0], data: 'aW1hZ2U=' }],
        },
      })
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    expect(call).not.toHaveBeenCalled();
    const delivery = surface.call('conversations.acp.sendPrompt', input);
    const retry = surface.call('conversations.acp.sendPrompt', input);
    await expect(Promise.all([delivery, retry])).resolves.toEqual([
      { success: true, data: { queued: false } },
      { success: true, data: { queued: false } },
    ]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(
      1,
      'attachments.upload',
      { conversationId: 'c1' },
      { uploadFile: expect.objectContaining({ name: 'shot.png', mimeType: 'image/png', size: 8 }) }
    );
    expect(call).toHaveBeenNthCalledWith(2, 'acp.sendPrompt', {
      ...input,
      prompt: {
        text: '',
        attachments: [
          { type: 'attachment', id: 'stored-image', name: 'shot.png', mimeType: 'image/png' },
        ],
      },
    });
  });

  it('lets the phone remove or reorder a queued message', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    await expect(
      surface.call('conversations.acp.deleteQueuedPrompt', { conversationId: 'c', id: 'q1' })
    ).resolves.toBe('called');
    await expect(
      surface.call('conversations.acp.changeQueuePromptOrder', {
        conversationId: 'c',
        ids: ['q2', 'q1'],
      })
    ).resolves.toBe('called');
    for (const bad of [
      { conversationId: 'c' },
      { conversationId: 'c', id: '' },
      { conversationId: 'c', id: 'q1', extra: true },
    ]) {
      await expect(surface.call('conversations.acp.deleteQueuedPrompt', bad)).rejects.toMatchObject(
        { code: 'CONTRACT_MISMATCH' }
      );
    }
  });

  it('lets the phone read media ranges anywhere in multi-GB files within the frame budget', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    const base = { conversationId: 'c1', uri: '/tmp/render.mp4' };
    // 5 GB'tan sonraki bir konum ve 8 MiB'lık parça kabul edilir (eski sınırlar: 40 MB / 1.6 MB).
    await expect(
      surface.call('conversations.readMediaPreview', {
        ...base,
        offset: 5 * 1024 * 1024 * 1024,
        maxBytes: 8 * 1024 * 1024,
      })
    ).resolves.toBe('called');
    for (const bad of [
      { ...base, maxBytes: 8 * 1024 * 1024 + 1 },
      { ...base, maxBytes: 100 },
      { ...base, offset: -1 },
      { ...base, offset: 1.5 },
      { ...base, extra: true },
    ]) {
      await expect(surface.call('conversations.readMediaPreview', bad)).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }
  });

  it('guards setOption, cancelSubagent and handoff mutations strictly', async () => {
    const controllers = allDomainSpies();
    const surface = createRemoteSurfaceController(controllers);
    const runId = '3b241101-e2bb-4255-8caf-4136c566a962';

    await expect(
      surface.call('conversations.acp.setOption', {
        conversationId: 'c1',
        key: 'effort',
        value: 'high',
      })
    ).resolves.toBe('called');
    for (const bad of [
      { conversationId: '', key: 'model', value: 'gpt-5' },
      { conversationId: 'c1', key: 'secret', value: 'x' },
      { conversationId: 'c1', key: 'mode', value: '' },
      { conversationId: 'c1', key: 'model', value: 'm'.repeat(257) },
      { conversationId: 'c1', key: 'effort', value: 'high', extra: 1 },
      null,
    ]) {
      await expect(surface.call('conversations.acp.setOption', bad)).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }

    await expect(
      surface.call('conversations.acp.cancelSubagent', { conversationId: 'c1', runId })
    ).resolves.toBe('called');
    for (const bad of [
      { conversationId: 'c1', runId: 'not-a-uuid' },
      { conversationId: '', runId },
      { conversationId: 'c1', runId, force: true },
      {},
    ]) {
      await expect(surface.call('conversations.acp.cancelSubagent', bad)).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }

    await expect(surface.call('conversations.handoff.listAll', undefined)).resolves.toBe('called');
    expect(controllers.conversations!.call).toHaveBeenCalledWith(
      'handoff.listAll',
      undefined,
      undefined
    );

    const validHandoff = {
      conversationId: 'c2',
      record: {
        version: 1,
        mode: 'handoff',
        sourceConversationId: 'c1',
        sourceTitle: 'Önceki sohbet',
        context: 'Özet metni',
        contextDelivered: false,
        createdAt: 1700000000000,
        targetEffort: 'high',
        chain: [
          {
            conversationId: 'c1',
            fromProviderId: 'claude',
            fromModelLabel: 'Sonnet',
            toProviderId: 'codex',
            toModelLabel: 'GPT',
            createdAt: 1700000000000,
          },
        ],
      },
    };
    await expect(surface.call('conversations.handoff.put', validHandoff)).resolves.toBe('called');
    for (const bad of [
      { ...validHandoff, extra: 'x' },
      { ...validHandoff, conversationId: '' },
      { ...validHandoff, record: { ...validHandoff.record, version: 2 } },
      { ...validHandoff, record: { ...validHandoff.record, mode: 'unknown' } },
      { ...validHandoff, record: { ...validHandoff.record, secretPath: '/etc/passwd' } },
      { ...validHandoff, record: { ...validHandoff.record, context: 'x'.repeat(50_001) } },
      {
        ...validHandoff,
        record: {
          ...validHandoff.record,
          chain: Array.from({ length: 33 }, () => validHandoff.record.chain[0]),
        },
      },
    ]) {
      await expect(surface.call('conversations.handoff.put', bad)).rejects.toMatchObject({
        code: 'CONTRACT_MISMATCH',
      });
    }

    await expect(
      surface.call('conversations.handoff.markSuperseded', {
        oldConversationId: 'c1',
        newConversationId: 'c2',
      })
    ).resolves.toBe('called');
    for (const bad of [
      { oldConversationId: '', newConversationId: 'c2' },
      { oldConversationId: 'c1', newConversationId: '' },
      { oldConversationId: 'c1', newConversationId: 'c2', extra: true },
      null,
    ]) {
      await expect(surface.call('conversations.handoff.markSuperseded', bad)).rejects.toMatchObject(
        { code: 'CONTRACT_MISMATCH' }
      );
    }
  });

  it('is documented: every allowlisted entry appears in the protocol document', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(
      resolve(here, '../../../../../../..', 'agents/architecture/remote-access.md'),
      'utf8'
    );
    for (const entry of [...Object.keys(REMOTE_ALLOWED_PROCEDURES), ...REMOTE_ALLOWED_TOPICS]) {
      expect(doc, `${entry} missing from remote-access.md`).toContain(`\`${entry}\``);
    }
  });
});

describe('remote-only agent activity surface', () => {
  it('lists only endpoints of the agentActivity contract and documents them', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(
      resolve(here, '../../../../../../..', 'agents/architecture/remote-access.md'),
      'utf8'
    );
    const contract = agentActivityContract as unknown as Record<string, { kind?: string }>;
    for (const path of Object.keys(REMOTE_ONLY_PROCEDURES)) {
      const [domain, name] = path.split('.');
      expect(domain).toBe('agentActivity');
      expect(contract[name!]?.kind).toBe('procedure');
      expect(doc).toContain(`\`${path}\``);
    }
    for (const topic of REMOTE_ONLY_TOPICS) {
      const [domain, name] = topic.split('.');
      expect(domain).toBe('agentActivity');
      expect(contract[name!]?.kind).toBe('eventStream');
      expect(doc).toContain(`\`${topic}\``);
    }
    expect(isRemoteProcedureAllowed('agentActivity.getSnapshot')).toBe(true);
    expect(isRemoteTopicAllowed('agentActivity.events')).toBe(true);
  });

  it('gives the background notifications channel nothing but the activity feed', async () => {
    const controllers = {
      ...allDomainSpies(),
      agentActivity: spyController(),
    };
    const surface = createRemoteNotificationsSurfaceController(controllers);
    expect([...REMOTE_NOTIFICATIONS_PROCEDURES]).toEqual(['agentActivity.getSnapshot']);
    expect([...REMOTE_NOTIFICATIONS_TOPICS]).toEqual(['agentActivity.events']);
    await expect(surface.call('agentActivity.getSnapshot', undefined)).resolves.toBe('called');
    expect(surface.resolveLive('agentActivity.events')).not.toBeNull();
    for (const path of Object.keys(REMOTE_ALLOWED_PROCEDURES)) {
      await expect(surface.call(path, {})).rejects.toBeInstanceOf(WireError);
    }
    for (const topic of REMOTE_ALLOWED_TOPICS) {
      expect(surface.resolveLive(topic)).toBeNull();
      expect(surface.acquireLive(topic)).toBeNull();
    }
  });
});
