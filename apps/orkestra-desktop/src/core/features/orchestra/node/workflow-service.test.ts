import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowRun } from '@core/features/orchestra/api/workflow';
import type { WorkflowWorkerPort } from '@core/features/orchestra/node/workflow-runner';
import { WorkflowService } from '@core/features/orchestra/node/workflow-service';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const workflow: WorkflowDefinition = {
  id: 'wf1',
  name: 'Gözden geçir',
  steps: [
    { id: 'a', agent: 'claude', prompt: 'Yaz: {{input}}', dependsOn: [] },
    { id: 'b', agent: 'codex', prompt: 'İncele: {{steps.a.report}}', dependsOn: ['a'] },
  ],
};

function instantPort(): WorkflowWorkerPort {
  let counter = 0;
  return {
    startWorker: async ({ stepId }) => ({ workerId: `w-${stepId}-${(counter += 1)}` }),
    sendPrompt: async () => ({ promptId: 'p' }),
    waitForReport: async () => ({ status: 'done', report: 'tamam', errorMessage: null }),
    cancel: async () => undefined,
  };
}

function hangingPort(): WorkflowWorkerPort {
  return {
    ...instantPort(),
    waitForReport: ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () =>
          resolve({ status: 'cancelled', report: null, errorMessage: null })
        )
      ),
  };
}

describe('WorkflowService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orkestra-workflow-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = (port: WorkflowWorkerPort) =>
    new WorkflowService({ dataDirectory: dir, logger: logger as never, createPort: () => port });

  async function waitForStatus(service: WorkflowService, id: string, status: WorkflowRun['status']) {
    for (let i = 0; i < 200; i += 1) {
      const run = await service.getRun(id);
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Çalıştırma ${status} olmadı`);
  }

  it('tanımı sürümlü JSON olarak kaydeder ve yeniden okur', async () => {
    const service = create(instantPort());
    expect((await service.save(workflow)).ok).toBe(true);
    const stored = JSON.parse(await readFile(join(dir, 'orchestra', 'workflows.json'), 'utf8'));
    expect(stored.version).toBe('1');
    expect(stored.workflows).toHaveLength(1);
    expect(await create(instantPort()).list()).toEqual([workflow]);
  });

  it('geçersiz tanımı (döngü) kaydetmez ve hata döner', async () => {
    const service = create(instantPort());
    const result = await service.save({
      ...workflow,
      steps: [
        { ...workflow.steps[0]!, dependsOn: ['b'] },
        { ...workflow.steps[1]!, prompt: 'x' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('döngü');
    expect(await service.list()).toEqual([]);
  });

  it('çalıştırmayı tamamlar ve kaydeder', async () => {
    const service = create(instantPort());
    await service.save(workflow);
    const started = await service.startRun({
      projectId: 'p',
      taskId: 't',
      workflowId: 'wf1',
      input: 'hedef',
      autoApprove: false,
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const run = await waitForStatus(service, started.run.id, 'completed');
    expect(run.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
    await service.dispose();
    const stored = JSON.parse(await readFile(join(dir, 'orchestra', 'workflow-runs.json'), 'utf8'));
    expect(stored.runs[0].status).toBe('completed');
  });

  it('bilinmeyen iş akışını reddeder', async () => {
    const result = await create(instantPort()).startRun({
      projectId: 'p',
      taskId: 't',
      workflowId: 'yok',
      input: '',
      autoApprove: false,
      maxConcurrency: 1,
    });
    expect(result).toEqual({ ok: false, errors: ['İş akışı bulunamadı.'] });
  });

  it('kullanıcı çalıştırmayı iptal edebilir', async () => {
    const service = create(hangingPort());
    await service.save(workflow);
    const started = await service.startRun({
      projectId: 'p',
      taskId: 't',
      workflowId: 'wf1',
      input: '',
      autoApprove: false,
      maxConcurrency: 1,
    });
    if (!started.ok) throw new Error('başlamadı');
    expect(await service.cancelRun(started.run.id)).toBe(true);
    const run = await service.getRun(started.run.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(await service.cancelRun(started.run.id)).toBe(false);
  });

  it('uygulama yeniden başlayınca yarım kalan çalıştırmayı cancelled işaretler', async () => {
    const first = create(hangingPort());
    await first.save(workflow);
    const started = await first.startRun({
      projectId: 'p',
      taskId: 't',
      workflowId: 'wf1',
      input: '',
      autoApprove: false,
      maxConcurrency: 1,
    });
    if (!started.ok) throw new Error('başlamadı');
    // Süreç "çöktü": disk durumu bırakılır, yeni bir servis aynı dizini açar.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const restarted = create(instantPort());
    const run = await restarted.getRun(started.run.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(run?.steps[0]!.error).toContain('yeniden başladığı');
    // Yeniden başlatma kayda da yazılır.
    await restarted.dispose();
    const stored = JSON.parse(await readFile(join(dir, 'orchestra', 'workflow-runs.json'), 'utf8'));
    expect(stored.runs[0].status).toBe('cancelled');
    await first.dispose();
  });

  it('bozuk dosyayı yok sayar ve çökmez', async () => {
    await mkdir(join(dir, 'orchestra'), { recursive: true });
    await writeFile(join(dir, 'orchestra', 'workflows.json'), '{bozuk');
    expect(await create(instantPort()).list()).toEqual([]);
  });
});
