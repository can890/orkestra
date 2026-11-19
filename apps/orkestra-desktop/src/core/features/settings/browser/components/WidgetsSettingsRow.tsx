import { Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/** Ajanın sohbete satır içi widget koymasını (`orkestra-widgets`) açıp kapatır. */
export function WidgetsSettingsRow() {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('widgets');
  const title = 'Sohbet içi widget’lar';
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={title}
      description="Ajanların sohbete etkileşimli HTML/SVG widget'ları koymasına izin verir. Widget'lar ağ erişimi olmayan korumalı bir çerçevede çalışır. Değişiklik yeni başlayan oturumlarda geçerli olur."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('enabled')}
            defaultLabel="açık"
            onReset={() => resetField('enabled')}
            disabled={disabled}
          />
          <Switch
            aria-label={title}
            checked={value?.enabled ?? true}
            disabled={disabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </>
      }
    />
  );
}
