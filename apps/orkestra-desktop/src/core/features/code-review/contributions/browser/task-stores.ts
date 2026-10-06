import { AutoReviewController } from '@core/features/code-review/browser/auto-review-controller';
import type { TaskScopedStoreContext } from '@core/features/tasks/contributions/browser/task-stores';
import {
  contributeScopedStore,
  scopedStoreToken,
  type ScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

export const autoReviewControllerToken =
  scopedStoreToken<AutoReviewController>('code-review.auto-review');

/** Konuşma yöneticisinden sonra oluşturulmalıdır; manifestte konuşmaların ardından gelir. */
export const codeReviewTaskStoreContributions: readonly ScopedStoreContribution<TaskScopedStoreContext>[] =
  [
    contributeScopedStore({
      token: autoReviewControllerToken,
      create: ({ projectId, taskId }) => new AutoReviewController(projectId, taskId),
      dispose: (controller) => controller.dispose(),
    }),
  ];
