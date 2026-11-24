import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

/**
 * Kod iş akışları (`~/.orkestra/workflows`). Varsayılan kapalı: kapalıyken klasördeki hiçbir şey
 * çalışmaz; çalıştırmalar saklanır ve özellik yeniden açılınca sürer.
 */
export const codeWorkflowsSettingsContribution = defineSettingsContribution<
  'codeWorkflows',
  { enabled: boolean }
>({
  key: 'codeWorkflows',
  schema: z.object({ enabled: z.boolean() }),
  defaults: { enabled: false },
});
