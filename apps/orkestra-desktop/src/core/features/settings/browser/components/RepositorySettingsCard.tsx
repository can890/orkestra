import { SettingsCard } from '@orkestra/ui/react/patterns';
import { Input, Select, SeparatedList, Switch } from '@orkestra/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { BranchNamingMode } from '@core/primitives/app-settings/api';
import { normalizeBranchPrefix } from '@core/primitives/tasks/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const RepositorySettingsCard: React.FC = () => {
  const {
    value: project,
    update: updateProject,
    isLoading: projectLoading,
    isSaving: projectSaving,
    isFieldOverridden: isProjectFieldOverridden,
    resetField: resetProjectField,
  } = useAppSettingsKey('project');
  const branchPrefix = project?.branchPrefix ?? '';
  const branchNamingMode = project?.branchNamingMode ?? 'static';
  const branchNamingInstructions = project?.branchNamingInstructions ?? '';
  const autoArchiveMergedPrTasks = project?.autoArchiveMergedPrTasks ?? false;
  const appendRandomBranchSuffix = project?.appendRandomBranchSuffix ?? true;
  const pushOnCreate = project?.pushOnCreate ?? true;
  const projectBusy = projectLoading || projectSaving;

  return (
    <SettingsCard>
      <SeparatedList gap="1rem" direction="column">
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Input
              key={branchPrefix}
              defaultValue={branchPrefix}
              onBlur={(e) => {
                const next = normalizeBranchPrefix(e.currentTarget.value);
                e.currentTarget.value = next;
                if (next !== branchPrefix) {
                  updateProject({ branchPrefix: next });
                }
              }}
              placeholder="Branch prefix"
              aria-label="Branch prefix"
              disabled={projectBusy}
              className="flex-1"
            />
            <ResetToDefaultButton
              visible={isProjectFieldOverridden('branchPrefix')}
              defaultLabel="orkestra"
              onReset={() => resetProjectField('branchPrefix')}
              disabled={projectBusy}
            />
          </div>
          <div className="text-xs text-foreground-passive">
            Leave empty to create branches without a prefix.
          </div>
        </div>
        <SettingRow
          title="Random branch suffix"
          description="Add a random suffix to branch names."
          control={
            <>
              <ResetToDefaultButton
                visible={isProjectFieldOverridden('appendRandomBranchSuffix')}
                defaultLabel="on"
                onReset={() => resetProjectField('appendRandomBranchSuffix')}
                disabled={projectBusy}
              />
              <Switch
                checked={appendRandomBranchSuffix}
                onCheckedChange={(checked) => updateProject({ appendRandomBranchSuffix: checked })}
                disabled={projectBusy}
                aria-label="Append random branch suffix"
              />
            </>
          }
        />
        <SettingRow
          title="Auto-push on create"
          description="Push the new branch to the selected project remote and set upstream after creation."
          control={
            <>
              <ResetToDefaultButton
                visible={isProjectFieldOverridden('pushOnCreate')}
                defaultLabel="on"
                onReset={() => resetProjectField('pushOnCreate')}
                disabled={projectBusy}
              />
              <Switch
                checked={pushOnCreate}
                onCheckedChange={(checked) => updateProject({ pushOnCreate: checked })}
                disabled={projectBusy}
                aria-label="Enable automatic push on create"
              />
            </>
          }
        />
        <SettingRow
          title="Dal adlandırma modu"
          description="Yeni görev dallarında sabit ön ek, göreve göre anlamsal ön ek (feat/fix/docs) veya özel kural kullanın."
          control={
            <Select.Root
              value={branchNamingMode}
              onValueChange={(next) => updateProject({ branchNamingMode: next as BranchNamingMode })}
              disabled={projectBusy}
            >
              <Select.Trigger className="w-[210px] shrink-0">
                <Select.Value>
                  {branchNamingMode === 'semantic'
                    ? 'Anlamsal (feat/fix/docs)'
                    : branchNamingMode === 'custom'
                      ? 'Özel Kural'
                      : 'Sabit Ön Ek'}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                <Select.Item value="static">Sabit Ön Ek</Select.Item>
                <Select.Item value="semantic">Anlamsal (feat/fix/docs)</Select.Item>
                <Select.Item value="custom">Özel Kural</Select.Item>
              </Select.Content>
            </Select.Root>
          }
        />
        {branchNamingMode === 'custom' && (
          <SettingRow
            title="Özel dal adlandırma kuralı"
            description="Dal ön eki boşsa ilk sözcük ön ek kalıbı olarak kullanılır."
            control={
              <Input
                value={branchNamingInstructions}
                onChange={(e) => updateProject({ branchNamingInstructions: e.target.value })}
                placeholder="ör. team/feature"
                className="w-[220px]"
                disabled={projectBusy}
              />
            }
          />
        )}
        <SettingRow
          title="PR birleşince görevi otomatik arşivle"
          description="Göreve bağlı Pull Request durumu birleşti (merged) olduğunda görevi otomatik arşivler."
          control={
            <Switch
              checked={autoArchiveMergedPrTasks}
              onCheckedChange={(checked) => updateProject({ autoArchiveMergedPrTasks: checked })}
              disabled={projectBusy}
              aria-label="PR birleşince görevi otomatik arşivle"
            />
          }
        />
      </SeparatedList>
    </SettingsCard>
  );
};

export default RepositorySettingsCard;
