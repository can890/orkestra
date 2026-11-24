import { Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

export function TrayIconSettingsRow() {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('interface');
  const location = detectPlatformContext().os === 'mac' ? 'menu bar' : 'system tray';
  const title = `Show Sovra in the ${location}`;
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={title}
      description={`Quick access to Sovra from the ${location}.`}
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('showTrayIcon')}
            defaultLabel="shown"
            onReset={() => resetField('showTrayIcon')}
            disabled={disabled}
          />
          <Switch
            aria-label={title}
            checked={value?.showTrayIcon ?? true}
            disabled={disabled}
            onCheckedChange={(checked) => update({ showTrayIcon: checked })}
          />
        </>
      }
    />
  );
}
