import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export type ComputerUseSettings = {
  /**
   * Genel kilit: kapalıyken hiçbir sohbete masaüstü kontrol araçları eklenmez. Açıldığında tüm
   * yerel sohbetlerde otomatik olarak etkinleşir; kullanıcı aktif sohbette tek tıkla durdurabilir.
   */
  enabled: boolean;
};

export const computerUseSettingsContribution = defineSettingsContribution<
  'computerUse',
  ComputerUseSettings
>({
  key: 'computerUse',
  schema: z.object({ enabled: z.boolean() }),
  defaults: { enabled: false },
});
