import { SettingsSection } from '@orkestra/ui/react/patterns';
import { Input, Select, Switch } from '@orkestra/ui/react/primitives';
import {
  DEFAULT_PERMISSION_MODE_OPTIONS,
  permissionModeLabel,
} from '@core/features/conversations/api/default-permission-mode';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { SettingRow } from '@core/features/settings/browser/components/SettingRow';
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import type {
  ChatSettings,
  ChatWorkingTurnSubmitMode,
  DefaultPermissionMode,
} from '@core/primitives/app-settings/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';

const DEFAULT_CHAT: ChatSettings = {
  workingTurnSubmitMode: 'queue',
  showContextCompactionBanner: true,
  cacheExpiryWarningMinutes: 4,
};

export function ChatBehaviorSettingsCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('chat');
  const taskSettings = useTaskSettings();
  const current = value ?? DEFAULT_CHAT;

  return (
    <SettingsSection title="Sohbet Davranışı">
      <SettingRow
        title="Varsayılan izin modu"
        description="Yeni sohbet ve görevlerde kullanılacak varsayılan izin davranışını belirleyin; her sohbette yeniden seçmeniz gerekmez."
        control={
          <>
            <ResetToDefaultButton
              visible={
                taskSettings.isFieldOverridden('defaultPermissionMode') ||
                taskSettings.isFieldOverridden('autoApproveByDefault')
              }
              defaultLabel="Manual"
              onReset={taskSettings.resetDefaultPermissionMode}
              disabled={taskSettings.loading || taskSettings.saving}
            />
            <Select.Root
              value={taskSettings.defaultPermissionMode}
              onValueChange={(next) => {
                if (next) taskSettings.updateDefaultPermissionMode(next as DefaultPermissionMode);
              }}
              disabled={taskSettings.loading || taskSettings.saving}
            >
              <Select.Trigger className="w-[230px] shrink-0">
                <Select.Value>
                  {permissionModeLabel(taskSettings.defaultPermissionMode)}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end" className="min-w-[290px]">
                {DEFAULT_PERMISSION_MODE_OPTIONS.map((option) => (
                  <Select.Item key={option.id} value={option.id}>
                    <div className="flex flex-col py-0.5 text-left">
                      <span className="font-medium text-foreground">{option.label}</span>
                      <span className="text-[11px] leading-tight text-foreground-muted">
                        {option.description}
                      </span>
                    </div>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </>
        }
      />

      <SettingRow
        title="Ajan çalışırken yeni mesaj gönderme"
        description="Ajan aktif turdayken Enter'a bastığınızda mesajın sıraya mı alınacağını yoksa canlı yönlendirme (destekleyen ajanlarda kesintisiz, diğerlerinde mevcut turu kesip hemen) gönderileceğini seçin."
        control={
          <Select.Root
            value={current.workingTurnSubmitMode}
            onValueChange={(next) =>
              update({ workingTurnSubmitMode: next as ChatWorkingTurnSubmitMode })
            }
            disabled={isLoading || isSaving}
          >
            <Select.Trigger className="w-[240px] shrink-0">
              <Select.Value>
                {current.workingTurnSubmitMode === 'steer-cancel'
                  ? 'Canlı Yönlendir (Steer) / Kes & Gönder'
                  : 'Sıraya Al (Varsayılan)'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              <Select.Item value="queue">Sıraya Al (Varsayılan)</Select.Item>
              <Select.Item value="steer-cancel">
                Canlı Yönlendir (Steer) / Kes & Gönder
              </Select.Item>
            </Select.Content>
          </Select.Root>
        }
      />

      <SettingRow
        title="Bağlam ve önbellek sıkıştırma uyarısı"
        description="Bağlam %75 dolduğunda veya uzun beklemelerde /compact öneri şeridi göster."
        control={
          <Switch
            aria-label="Bağlam ve önbellek sıkıştırma uyarısı"
            checked={current.showContextCompactionBanner}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ showContextCompactionBanner: checked })}
          />
        }
      />

      <SettingRow
        title="Önbellek soğuma uyarısı (dakika)"
        description="Uzun sohbetlerde son turdan sonra kaç dakika hareketsizlikte önbellek uyarısı gösterilsin."
        control={
          <Input
            type="number"
            min={1}
            max={30}
            value={current.cacheExpiryWarningMinutes}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 30) {
                update({ cacheExpiryWarningMinutes: parsed });
              }
            }}
            className="w-20"
            disabled={isLoading}
          />
        }
      />
    </SettingsSection>
  );
}
