import { describe, expect, it, vi } from 'vitest';
import type {
  WorkerOutcome,
  WorkflowWorkerPort,
} from '@core/features/orchestra/api/node/workflow-runner';
import { createPortAgentExecutor } from './agent-executor';
import type { AgentStepRequest } from './engine';

function fakePort(outcome: WorkerOutcome | 'hang'): WorkflowWorkerPort & {
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    startWorker: vi.fn(async () => ({ workerId: 'worker-1' })),
    sendPrompt: vi.fn(async () => ({ promptId: 'prompt-1' })),
    waitForReport: vi.fn(
      ({ signal }) =>
        new Promise<WorkerOutcome>((resolve) => {
          if (outcome !== 'hang') return resolve(outcome);
          signal.addEventListener('abort', () =>
            resolve({ status: 'cancelled', report: null, errorMessage: null })
          );
        })
    ),
    cancel: vi.fn(async () => undefined),
  };
}

function request(overrides: Partial<AgentStepRequest> = {}): AgentStepRequest {
  return {
    runId: 'run-1',
    workflow: 'wf',
    step: 'review',
    attempt: 1,
    task: 'task-1',
    conversation: null,
    provider: 'claude',
    model: null,
    brief: 'Review',
    title: 'wf: review',
    autoApprove: false,
    timeoutMs: null,
    signal: new AbortController().signal,
    onConversation: vi.fn(),
    ...overrides,
  };
}

const lookups = {
  resolveTask: async (taskId: string) => (taskId === 'task-1' ? { projectId: 'p1', taskId } : null),
  resolveConversation: async () => ({ projectId: 'p1', taskId: 'task-1' }),
};

describe('createPortAgentExecutor', () => {
  it('opens a conversation in the task and returns the final report', async () => {
    const port = fakePort({ status: 'done', report: 'all good', errorMessage: null });
    const executor = createPortAgentExecutor({ ...lookups, createPort: () => port });
    const input = request();
    expect(await executor.run(input)).toEqual({
      status: 'done',
      report: 'all good',
      conversationId: 'worker-1',
    });
    expect(port.startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', stepId: 'review', title: 'wf: review' })
    );
    expect(input.onConversation).toHaveBeenCalledWith({
      conversationId: 'worker-1',
      projectId: 'p1',
      taskId: 'task-1',
    });
  });

  it('reports an unknown task as not started and a cut-off turn as retryable', async () => {
    const executor = createPortAgentExecutor({
      ...lookups,
      createPort: () => fakePort({ status: 'lost', report: null, errorMessage: 'gone' }),
    });
    expect(await executor.run(request({ task: 'missing' }))).toMatchObject({
      status: 'failed',
      started: false,
    });
    expect(await executor.run(request())).toMatchObject({
      status: 'failed',
      started: true,
      retryable: true,
      message: 'gone',
    });
  });

  it('stops the turn when it runs past its timeout', async () => {
    const port = fakePort('hang');
    const executor = createPortAgentExecutor({ ...lookups, createPort: () => port });
    const outcome = await executor.run(request({ timeoutMs: 20 }));
    expect(outcome).toMatchObject({ status: 'failed', started: true, retryable: false });
    expect(outcome.status === 'failed' && outcome.message).toContain('did not finish');
    expect(port.cancel).toHaveBeenCalledWith('worker-1');
  });

  it('does not stop agent turns when the app shuts down', async () => {
    const port = fakePort('hang');
    const executor = createPortAgentExecutor({ ...lookups, createPort: () => port });
    const controller = new AbortController();
    const pending = executor.run(request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort('shutdown');
    await pending;
    expect(port.cancel).not.toHaveBeenCalled();
  });
});
