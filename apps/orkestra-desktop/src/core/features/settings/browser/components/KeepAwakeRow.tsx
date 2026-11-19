import { Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const TITLE = 'Ajanlar çalışırken bilgisayarı uyanık tut';

/** Bir sohbet çalışırken bilgisayarın uykuya geçmesini engeller; ekranı açık tutmaz. */
export function KeepAwakeRow() {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('power');
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={TITLE}
      description="En az bir ajan çalıştığı sürece bilgisayar uykuya geçmez; ajanlar bitince engel kalkar. Ekran yine kapanabilir."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('keepAwakeWhileWorking')}
            defaultLabel="kapalı"
            onReset={() => resetField('keepAwakeWhileWorking')}
            disabled={disabled}
          />
          <Switch
            aria-label={TITLE}
            checked={value?.keepAwakeWhileWorking ?? false}
            disabled={disabled}
            onCheckedChange={(checked) => update({ keepAwakeWhileWorking: checked })}
          />
        </>
      }
    />
  );
}
