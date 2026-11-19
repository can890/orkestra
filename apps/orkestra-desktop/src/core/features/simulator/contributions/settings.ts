import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

/**
 * iOS Simülatör ayarları. Ajan araçları (ekran görüntüsü, URL açma, uygulama kurma) varsayılan
 * olarak kapalıdır; kullanıcı simülatör panelinden açıkça izin verir.
 */
export const simulatorSettingsContribution = defineSettingsContribution<
  'simulator',
  { agentToolsEnabled: boolean }
>({
  key: 'simulator',
  schema: z.object({ agentToolsEnabled: z.boolean() }),
  defaults: { agentToolsEnabled: false },
});
