import { SettingsRow } from '@orkestra/ui/react/patterns';
import { Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

/** Kod iş akışlarını (`~/.orkestra/workflows`) açıp kapatır; varsayılan kapalı. */
export function WorkflowsSettingsRow() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('codeWorkflows');
  const label = 'Workflows';
  return (
    <SettingsRow
      label={label}
      description="Run durable workflows written as code from ~/.orkestra/workflows. Workflow files run inside Orkestra with your user's permissions; only add files you trust. While off, nothing in the folder runs."
      control={
        <Switch
          aria-label={label}
          checked={value?.enabled ?? false}
          disabled={isLoading || isSaving}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      }
    />
  );
}
