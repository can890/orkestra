import { SettingsSection } from '@orkestra/ui/react/patterns';
import { Input, Select, Switch } from '@orkestra/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { SettingRow } from '@core/features/settings/browser/components/SettingRow';
import type { ChatSettings, ChatWorkingTurnSubmitMode } from '@core/primitives/app-settings/api';

const DEFAULT_CHAT: ChatSettings = {
  workingTurnSubmitMode: 'queue',
  showContextCompactionBanner: true,
  cacheExpiryWarningMinutes: 4,
};

export function ChatBehaviorSettingsCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('chat');
  const current = value ?? DEFAULT_CHAT;

  return (
    <SettingsSection title="Sohbet Davranışı">
      <SettingRow
        title="Ajan çalışırken yeni mesaj gönderme"
        description="Ajan aktif turdayken Enter'a bastığınızda mesajın sıraya mı alınacağını yoksa mevcut turu kesip hemen mi gönderileceğini seçin."
        control={
          <Select.Root
            value={current.workingTurnSubmitMode}
            onValueChange={(next) =>
              update({ workingTurnSubmitMode: next as ChatWorkingTurnSubmitMode })
            }
            disabled={isLoading || isSaving}
          >
            <Select.Trigger className="w-[210px] shrink-0">
              <Select.Value>
                {current.workingTurnSubmitMode === 'steer-cancel'
                  ? 'Mevcut Turu Kes & Gönder'
                  : 'Sıraya Al (Varsayılan)'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              <Select.Item value="queue">Sıraya Al (Varsayılan)</Select.Item>
              <Select.Item value="steer-cancel">Mevcut Turu Kes & Gönder</Select.Item>
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
