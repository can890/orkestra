// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/WorkflowAgentThreads.ts
//
// Ajan adımlarını, adım tabanlı iş akışlarının kullandığı aynı `WorkflowWorkerPort` üzerinden
// gerçek Orkestra ACP sohbetlerinde yürütür: seçilen sağlayıcı/model ile görevde yeni bir sohbet
// açar, kısa bilgiyi gönderir ve turun son yanıtını sonuç olarak döndürür.
import type { WorkflowWorkerPort } from '@core/features/orchestra/api/node/workflow-runner';
import type { AgentStepExecutor, AgentStepOutcome } from './engine';

type TaskContext = { projectId: string; taskId: string };

export type PortAgentExecutorDeps = {
  createPort(context: TaskContext): WorkflowWorkerPort;
  resolveTask(taskId: string): Promise<TaskContext | null>;
  resolveConversation(conversationId: string): Promise<TaskContext | null>;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPortAgentExecutor(deps: PortAgentExecutorDeps): AgentStepExecutor {
  const prompt = async (input: {
    port: WorkflowWorkerPort;
    conversationId: string;
    text: string;
    signal: AbortSignal;
    timeoutMs: number | null;
    autoApprove: boolean;
  }): Promise<AgentStepOutcome> => {
    const { port, conversationId } = input;
    let promptId: string;
    try {
      ({ promptId } = await port.sendPrompt({ workerId: conversationId, text: input.text }));
    } catch (error) {
      return {
        status: 'failed',
        message: `Could not send the brief: ${describe(error)}`,
        started: false,
        retryable: false,
        conversationId,
      };
    }
    const turn = new AbortController();
    const forward = () => turn.abort(input.signal.reason);
    input.signal.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    const timer =
      input.timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            turn.abort('timeout');
          }, input.timeoutMs);
    try {
      const outcome = await port.waitForReport({
        workerId: conversationId,
        promptId,
        autoApprove: input.autoApprove,
        signal: turn.signal,
        onPhase: () => undefined,
      });
      switch (outcome.status) {
        case 'done':
          return { status: 'done', report: outcome.report ?? '', conversationId };
        case 'lost':
          return {
            status: 'failed',
            message: outcome.errorMessage ?? 'The agent turn was cut off.',
            started: true,
            retryable: true,
            conversationId,
          };
        case 'error':
          return {
            status: 'failed',
            message: outcome.errorMessage ?? 'The agent turn ended with an error.',
            started: true,
            retryable: false,
            conversationId,
          };
        case 'cancelled': {
          // Zaman aşımında ya da çalıştırma iptalinde tur durdurulur; uygulama kapanışında değil.
          if (timedOut || input.signal.reason === 'cancel') {
            await port.cancel(conversationId).catch(() => undefined);
          }
          return {
            status: 'failed',
            message: timedOut
              ? `The agent did not finish within ${Math.round((input.timeoutMs ?? 0) / 1000)} seconds.`
              : 'The agent turn was stopped.',
            started: true,
            retryable: false,
            conversationId,
          };
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', forward);
    }
  };

  return {
    async run(request) {
      if (request.conversation) {
        const context = await deps.resolveConversation(request.conversation);
        if (!context) {
          return {
            status: 'failed',
            message: `Conversation ${request.conversation} was not found.`,
            started: false,
            retryable: false,
            conversationId: null,
          };
        }
        request.onConversation({ conversationId: request.conversation, ...context });
        return prompt({
          port: deps.createPort(context),
          conversationId: request.conversation,
          text: request.brief,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          autoApprove: request.autoApprove,
        });
      }
      const context = request.task ? await deps.resolveTask(request.task) : null;
      if (!context) {
        return {
          status: 'failed',
          message: `Task ${request.task ?? '(none)'} was not found. Pass the id of an existing task.`,
          started: false,
          retryable: false,
          conversationId: null,
        };
      }
      const port = deps.createPort(context);
      let workerId: string;
      try {
        ({ workerId } = await port.startWorker({
          runId: request.runId,
          stepId: request.step,
          agent: request.provider ?? '',
          model: request.model,
          title: request.title,
          autoApprove: request.autoApprove,
        }));
      } catch (error) {
        return {
          status: 'failed',
          message: describe(error),
          started: false,
          retryable: false,
          conversationId: null,
        };
      }
      request.onConversation({ conversationId: workerId, ...context });
      return prompt({
        port,
        conversationId: workerId,
        text: request.brief,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        autoApprove: request.autoApprove,
      });
    },

    async followUp(request) {
      const context = await deps.resolveConversation(request.conversationId);
      if (!context) {
        return {
          status: 'failed',
          message: `Conversation ${request.conversationId} was not found.`,
          started: true,
          retryable: false,
          conversationId: request.conversationId,
        };
      }
      return prompt({ port: deps.createPort(context), ...request });
    },
  };
}
