import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';
import { REVIEW_FOCUS_AREAS, REVIEW_SCOPES } from '../api/review-model';
import { MAX_REVIEW_INSTRUCTIONS_LENGTH } from '../api/review-prompt';

/** Bir projenin inceleme tercihleri: otomatik inceleme anahtarı ve son seçilen inceleyici. */
const projectReviewSettingsSchema = z.object({
  autoReview: z.boolean(),
  providerId: z.string().min(1).nullable(),
  model: z.string().nullable(),
  scope: z.enum(REVIEW_SCOPES),
  focus: z.array(z.enum(REVIEW_FOCUS_AREAS)),
  instructions: z.string().max(MAX_REVIEW_INSTRUCTIONS_LENGTH),
  autoApprove: z.boolean(),
});
export type ProjectReviewSettings = z.infer<typeof projectReviewSettingsSchema>;

export const codeReviewSettingsSchema = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      projects: z.record(z.string(), projectReviewSettingsSchema),
    })
  )
  .build();
export type CodeReviewSettingsState = typeof codeReviewSettingsSchema.Type;

export const DEFAULT_PROJECT_REVIEW_SETTINGS: ProjectReviewSettings = {
  autoReview: false,
  providerId: null,
  model: null,
  scope: 'uncommitted',
  focus: [...REVIEW_FOCUS_AREAS],
  instructions: '',
  autoApprove: false,
};

export const codeReviewSettingsMemento = defineMemento({
  id: 'code-review.settings',
  subject: appSubject,
  schema: codeReviewSettingsSchema,
  default: { version: '1' as const, projects: {} },
  retention: {
    tier: 'persisted',
    // Kullanıcı ayarıdır; süresiz saklanır (servis sonlu bir pencere ister).
    maxAge: Number.MAX_SAFE_INTEGER,
    maxEntries: 1,
  },
});
