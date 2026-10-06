import { Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getUpdateStore } from '@core/features/updates/contributions/app-stores';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const TITLE = 'Güncellemeleri otomatik indir';

/** Yeni sürüm bulununca arka planda indirip doğrulamayı açar ya da kapatır. */
export function AutoDownloadUpdatesRow() {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('updates');
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={TITLE}
      description="Yeni sürüm arka planda indirilip doğrulanır; kurmak için yalnızca yeniden başlatmanız yeterli olur."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('autoDownload')}
            defaultLabel="açık"
            onReset={() => resetField('autoDownload')}
            disabled={disabled}
          />
          <Switch
            aria-label={TITLE}
            checked={value?.autoDownload ?? true}
            disabled={disabled}
            onCheckedChange={(checked) => {
              update({ autoDownload: checked });
              // Ayar açılınca bekleyen yeni sürümün indirmesi hemen başlar.
              const store = getUpdateStore();
              if (checked && store.installMode === 'in-app' && store.state.status === 'available') {
                void store.download();
              }
            }}
          />
        </>
      }
    />
  );
}
