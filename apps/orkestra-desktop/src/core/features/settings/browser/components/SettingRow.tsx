import { SettingsRow, type SettingsRowProps } from '@orkestra/ui/react/patterns';
import { Badge } from '@orkestra/ui/react/primitives';
import * as React from 'react';
import { useManagedSettingLock } from '@core/features/managed-policy/api/browser/use-managed-policy';

export interface SettingRowProps extends Omit<SettingsRowProps, 'label'> {
  title: React.ReactNode;
  /**
   * Yönetilen politikanın kilitleyebileceği ayar yolu (`tasks.defaultPermissionMode`). Kilitliyse
   * satır salt-okur gösterilir ve "Managed by your organization" rozeti eklenir.
   */
  managedPath?: string;
}

/**
 * Local SettingRow — a thin wrapper around `@orkestra/ui`'s `SettingsRow` that
 * preserves the existing `title` prop name used across the settings feature.
 */
export function SettingRow({ title, managedPath, control, ...props }: SettingRowProps) {
  const managedBy = useManagedSettingLock(managedPath);
  if (!managedBy) return <SettingsRow label={title} control={control} {...props} />;
  return (
    <SettingsRow
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {title}
          <Badge tone="info" variant="outline" title={`Managed by ${managedBy}`}>
            Managed by your organization
          </Badge>
        </span>
      }
      control={
        // `fieldset disabled` içindeki tüm form kontrollerini (anahtar, seçici, düğme) kapatır.
        <fieldset disabled aria-disabled className="contents">
          {control}
        </fieldset>
      }
      {...props}
    />
  );
}
