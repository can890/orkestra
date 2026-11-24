import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { DefaultPermissionMode } from '@core/primitives/app-settings/api';

export interface TaskSettingsModel {
  autoGenerateName: boolean;
  autoApproveByDefault: boolean;
  defaultPermissionMode: DefaultPermissionMode;
  autoTrustWorktrees: boolean;
  createBranchAndWorktree: boolean;
  deleteBranchByDefault: boolean;
  preserveNameCapitalization: boolean;
  includeIssueContextByDefault: boolean;
  loading: boolean;
  saving: boolean;
  isFieldOverridden: (
    field:
      | 'autoGenerateName'
      | 'autoApproveByDefault'
      | 'defaultPermissionMode'
      | 'autoTrustWorktrees'
      | 'createBranchAndWorktree'
      | 'deleteBranchByDefault'
      | 'preserveNameCapitalization'
      | 'includeIssueContextByDefault'
  ) => boolean;
  updateAutoGenerateName: (next: boolean) => void;
  updateAutoApproveByDefault: (next: boolean) => void;
  updateDefaultPermissionMode: (next: DefaultPermissionMode) => void;
  updateAutoTrustWorktrees: (next: boolean) => void;
  updateCreateBranchAndWorktree: (next: boolean) => void;
  updateDeleteBranchByDefault: (next: boolean) => void;
  updatePreserveNameCapitalization: (next: boolean) => void;
  updateIncludeIssueContextByDefault: (next: boolean) => void;
  resetAutoGenerateName: () => void;
  resetAutoApproveByDefault: () => void;
  resetDefaultPermissionMode: () => void;
  resetAutoTrustWorktrees: () => void;
  resetCreateBranchAndWorktree: () => void;
  resetDeleteBranchByDefault: () => void;
  resetPreserveNameCapitalization: () => void;
  resetIncludeIssueContextByDefault: () => void;
}

export function useTaskSettings(): TaskSettingsModel {
  const {
    value: tasks,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    update,
    resetField,
  } = useAppSettingsKey('tasks');

  const derivedDefaultPermissionMode: DefaultPermissionMode =
    !isFieldOverridden('defaultPermissionMode') && tasks?.autoApproveByDefault === true
      ? 'bypass'
      : (tasks?.defaultPermissionMode ?? 'default');

  return {
    autoGenerateName: tasks?.autoGenerateName ?? false,
    autoApproveByDefault: tasks?.autoApproveByDefault ?? false,
    defaultPermissionMode: derivedDefaultPermissionMode,
    autoTrustWorktrees: tasks?.autoTrustWorktrees ?? false,
    createBranchAndWorktree: tasks?.createBranchAndWorktree ?? true,
    deleteBranchByDefault: tasks?.deleteBranchByDefault ?? false,
    preserveNameCapitalization: tasks?.preserveNameCapitalization ?? false,
    includeIssueContextByDefault: tasks?.includeIssueContextByDefault ?? true,
    loading,
    saving,
    isFieldOverridden,
    updateAutoGenerateName: (next) => update({ autoGenerateName: next }),
    updateAutoApproveByDefault: (next) =>
      update({ autoApproveByDefault: next, defaultPermissionMode: next ? 'bypass' : 'default' }),
    updateDefaultPermissionMode: (next) =>
      update({ defaultPermissionMode: next, autoApproveByDefault: next === 'bypass' }),
    updateAutoTrustWorktrees: (next) => update({ autoTrustWorktrees: next }),
    updateCreateBranchAndWorktree: (next) => update({ createBranchAndWorktree: next }),
    updateDeleteBranchByDefault: (next) => update({ deleteBranchByDefault: next }),
    updatePreserveNameCapitalization: (next) => update({ preserveNameCapitalization: next }),
    updateIncludeIssueContextByDefault: (next) => update({ includeIssueContextByDefault: next }),
    resetAutoGenerateName: () => resetField('autoGenerateName'),
    resetAutoApproveByDefault: () => resetField('autoApproveByDefault'),
    resetDefaultPermissionMode: () => {
      resetField('defaultPermissionMode');
      if (tasks?.autoApproveByDefault) {
        resetField('autoApproveByDefault');
      }
    },
    resetAutoTrustWorktrees: () => resetField('autoTrustWorktrees'),
    resetCreateBranchAndWorktree: () => resetField('createBranchAndWorktree'),
    resetDeleteBranchByDefault: () => resetField('deleteBranchByDefault'),
    resetPreserveNameCapitalization: () => resetField('preserveNameCapitalization'),
    resetIncludeIssueContextByDefault: () => resetField('includeIssueContextByDefault'),
  };
}
