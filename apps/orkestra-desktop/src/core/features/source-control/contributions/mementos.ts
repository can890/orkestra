import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { taskSubject } from '@core/features/tasks/contributions/subject';
import { defineMemento } from '@core/primitives/mementos/api';
import { DEFAULT_PR_AUTOMATION_STATE, prAutomationStateSchema } from '../api/pr-automation';

export const prAutomationSchema = defineVersionedSchema()
  .initial('1', prAutomationStateSchema)
  .build();
export type PrAutomationMementoState = typeof prAutomationSchema.Type;

/**
 * Görev başına PR otomasyonu: "Otomatik düzelt" anahtarı, kullanıcının açtığı auto-merge isteği ve
 * döngü korkuluklarının defteri. Varsayılan her yerde kapalıdır; kayıt süresi dolarsa da kapanır.
 */
export const taskPrAutomationMemento = defineMemento({
  id: 'source-control.pr-automation',
  subject: taskSubject,
  schema: prAutomationSchema,
  default: DEFAULT_PR_AUTOMATION_STATE,
});
