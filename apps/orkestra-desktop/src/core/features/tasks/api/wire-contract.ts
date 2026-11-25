import type { Result } from '@orkestra/shared';
import {
  defineContract,
  fallible,
  liveModel,
  liveState,
  mutation,
  procedure,
} from '@orkestra/wire/rpc';
import z from 'zod';
import type { LinkedIssue } from '@core/primitives/linked-issues/api';
import {
  taskLifecycleStatuses,
  type CreateTaskError,
  type CreateTaskParams,
  type CreateTaskSuccess,
  type DeletePreflightResult,
  type DeleteTaskOptions,
  type RenameTaskError,
  type RenameTaskSuccess,
  type Task,
  type TaskListData,
  type TaskStatsData,
} from '@core/primitives/tasks/api';
import { mutationAckSchema, mutationErrorSchema } from '@core/primitives/wire/api/mutations';

export const deleteTaskInputSchema = z.object({
  taskId: z.string(),
  deleteWorktree: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  deleteConversations: z.boolean().optional(),
});

const taskIdInputSchema = z.object({
  taskId: z.string(),
});

export const tasksDomain = 'tasks' as const;

export const tasksWireContract = defineContract({
  createTask: procedure({
    input: z.custom<CreateTaskParams>(),
    output: z.custom<Result<CreateTaskSuccess, CreateTaskError>>(),
  }),
  getDeletePreflight: procedure({
    input: z.object({ projectId: z.string(), taskIds: z.array(z.string()) }),
    output: z.custom<DeletePreflightResult>(),
  }),
  deleteTask: procedure({
    input: z.object({
      projectId: z.string(),
      taskId: z.string(),
      options: z.custom<DeleteTaskOptions>().optional(),
    }),
    output: z.void(),
  }),
  deleteTasks: procedure({
    input: z.object({
      projectId: z.string(),
      taskIds: z.array(z.string()),
      options: z.custom<DeleteTaskOptions>().optional(),
    }),
    output: z.void(),
  }),
  teardownTask: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.custom<Result<void, { type: string; message: string; timeout?: number }>>(),
  }),
  generateTaskName: procedure({
    input: z.object({ title: z.string().optional(), description: z.string().optional() }),
    output: z.string(),
  }),
  autoTitleTask: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string(), prompt: z.string() }),
    output: z.string().nullable(),
  }),
  /**
   * One-time removal of empty "ghost" free chats left by the host-first registration race.
   * `openTaskIds` are never removed. `deferred` means the run should be retried later.
   */
  cleanupGhostFreeChats: procedure({
    input: z.object({ openTaskIds: z.array(z.string()) }),
    output: z.object({
      status: z.enum(['already-done', 'deferred', 'done']),
      removedCount: z.number().int().nonnegative(),
      completed: z.boolean(),
    }),
  }),
  taskList: liveModel({
    key: z.object({ projectId: z.string() }),
    states: {
      list: liveState({ data: z.custom<TaskListData>() }),
    },
    mutations: {
      rename: mutation({
        input: z.object({ taskId: z.string(), newName: z.string() }),
        data: z.custom<RenameTaskSuccess>(),
        error: z.custom<RenameTaskError>(),
      }),
      setStatus: mutation({
        input: z.object({ taskId: z.string(), status: taskLifecycleStatuses }),
        data: z.void(),
        error: z.never(),
      }),
      setPinned: mutation({
        input: z.object({ taskId: z.string(), isPinned: z.boolean() }),
        data: z.void(),
        error: z.never(),
      }),
      setLinkedIssue: mutation({
        input: z.object({ taskId: z.string(), issue: z.custom<LinkedIssue>().optional() }),
        data: z.void(),
        error: z.never(),
      }),
      convertAutomation: mutation({
        input: taskIdInputSchema,
        data: z.custom<Task | null>(),
        error: z.never(),
      }),
      archive: mutation({
        input: taskIdInputSchema,
        data: z.void(),
        error: z.never(),
      }),
      restore: mutation({
        input: taskIdInputSchema,
        data: z.void(),
        error: z.never(),
      }),
    },
  }),
  taskStats: liveModel({
    key: z.object({ projectId: z.string() }),
    states: {
      stats: liveState({ data: z.custom<TaskStatsData>() }),
    },
  }),
  delete: fallible({
    input: deleteTaskInputSchema,
    data: mutationAckSchema,
    error: mutationErrorSchema,
  }),
});

export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;
export type TasksWireContract = typeof tasksWireContract;
