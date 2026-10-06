import { defineVersionedSchema } from '@orkestra/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { days, defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

const logHealthPreferencesV1Schema = z.object({
  version: z.literal('1'),
  /** Yok sayılan grup anahtarı → yok sayılma zamanı (ms). */
  ignored: z.record(z.string(), z.number()),
  /** Kullanıcının gördüğü grup anahtarı → görülme zamanı (ms). */
  acknowledged: z.record(z.string(), z.number()),
  /** Bildirim gösterilen grup anahtarı → son bildirim zamanı (ms). */
  notified: z.record(z.string(), z.number()),
});

export const logHealthPreferencesSchema = defineVersionedSchema()
  .initial('1', logHealthPreferencesV1Schema)
  .build();
export type LogHealthPreferencesState = typeof logHealthPreferencesSchema.Type;

/** Günlük sağlığı tercihleri (yok sayılan/görülen gruplar); uygulama genelinde kalıcı. */
export const logHealthPreferencesMemento = defineMemento({
  id: 'logHealth.preferences',
  subject: appSubject,
  schema: logHealthPreferencesSchema,
  default: {
    version: '1' as const,
    ignored: {},
    acknowledged: {},
    notified: {},
  },
  retention: { tier: 'persisted', maxAge: days(365), maxEntries: 1 },
});
