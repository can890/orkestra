import type { Result, Unsubscribe } from '@orkestra/shared';
import type { Disposable, Scope } from '@orkestra/shared/concurrency';
import type { Readable } from '@orkestra/wire/state';
import type {
  AttachmentInvalidationCause,
  ProjectAttachmentError,
  ProjectAttachmentState,
  ProjectRecoveryRequestError,
} from '@core/features/projects/api/attachments';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';

export type ProjectAttachmentManagerHooks = {
  projectOpened: (projectId: string, provider: ProjectProvider) => void | Promise<void>;
  projectClosed: (projectId: string) => void | Promise<void>;
};

export interface ProjectAttachmentManager extends Disposable {
  track(projectId: string, owner: Scope): Readable<ProjectAttachmentState>;
  recover(projectId: string): Promise<Result<void, ProjectRecoveryRequestError>>;
  requireAttached(projectId: string): Result<ProjectProvider, ProjectAttachmentError>;
  invalidate(projectId: string, cause: AttachmentInvalidationCause): Promise<void>;
  release(): Promise<void>;
  on<K extends keyof ProjectAttachmentManagerHooks>(
    name: K,
    handler: ProjectAttachmentManagerHooks[K]
  ): Unsubscribe;
}
