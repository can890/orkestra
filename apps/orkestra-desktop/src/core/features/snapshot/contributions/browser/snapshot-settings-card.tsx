import { SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Badge, Button, Input, Select, Switch, toast } from '@orkestra/ui/react/primitives';
import { Camera, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getSnapshotClient } from '@core/features/snapshot/api/browser/client';
import type { SnapshotStatus } from '@core/features/snapshot/api/contract';
import type { SnapshotCaptureMode, SnapshotSettings } from '@core/primitives/app-settings/api';
import { detectPlatformContext } from '@core/primitives/keybindings/api';

const DEFAULT_SNAPSHOT: SnapshotSettings = {
  enabled: false,
  shortcut: 'CommandOrControl+Shift+9',
  captureMode: 'active-window',
  includeWindowMetadata: true,
};

export function SnapshotSettingsCard() {
  const isMac = detectPlatformContext().os === 'mac';
  const { value, update, isLoading, isSaving } = useAppSettingsKey('snapshot');
  const current = value ?? DEFAULT_SNAPSHOT;

  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [capturing, setCapturing] = useState(false);

  const refreshStatus = async () => {
    try {
      const client = await getSnapshotClient();
      setStatus(await client.getStatus());
    } catch {
      // Başlangıçta yoksay
    }
  };

  useEffect(() => {
    if (!isMac) return;
    void refreshStatus();
  }, [isMac, current.enabled, current.shortcut]);

  if (!isMac) return null;

  const handleCaptureNow = async () => {
    setCapturing(true);
    try {
      const client = await getSnapshotClient();
      const res = await client.captureNow();
      if (!res.success) {
        toast.error('SnapShot alınamadı', { description: res.error.message });
        return;
      }
      await refreshStatus();
    } finally {
      setCapturing(false);
    }
  };

  return (
    <SettingsSection title="Global SnapShot (macOS)">
      <SettingsRow
        label="Global pencere yakalama kısayolu"
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>
              Başka bir uygulamadayken aktif pencereyi yakalayıp doğrudan Orkestra sohbet kutusuna
              ekler.
            </span>
            {status && current.enabled && (
              <Badge variant="soft" tone={status.registered ? 'success' : 'warning'}>
                {status.registered ? 'Kısayol aktif' : 'Kayıt başarısız'}
              </Badge>
            )}
          </span>
        }
        control={
          <Switch
            aria-label="Global pencere yakalama kısayolu"
            checked={current.enabled}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />

      <SettingsRow
        label="Kısayol tuşları"
        description="Electron kısayol biçimi (ör. CommandOrControl+Shift+9)."
        control={
          <Input
            value={current.shortcut}
            onChange={(e) => update({ shortcut: e.target.value })}
            placeholder="CommandOrControl+Shift+9"
            className="w-[220px]"
            disabled={isLoading}
          />
        }
      />

      <SettingsRow
        label="Yakalama modu"
        description="Aktif Pencere ön plandaki pencereyi anında yakalar; Etkileşimli Alan seçim imleci açar."
        control={
          <Select.Root
            value={current.captureMode}
            onValueChange={(next) => update({ captureMode: next as SnapshotCaptureMode })}
            disabled={isLoading || isSaving}
          >
            <Select.Trigger className="w-[180px] shrink-0">
              <Select.Value>
                {current.captureMode === 'interactive' ? 'Etkileşimli Alan' : 'Aktif Pencere'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              <Select.Item value="active-window">Aktif Pencere</Select.Item>
              <Select.Item value="interactive">Etkileşimli Alan</Select.Item>
            </Select.Content>
          </Select.Root>
        }
      />

      <SettingsRow
        label="Pencere bilgisini ekle"
        description="Yakalanan uygulama adını ve pencere başlığını görselin yanında sohbete ekle."
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={capturing}
              onClick={() => void handleCaptureNow()}
            >
              {capturing ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
              Şimdi Yakala
            </Button>
            <Switch
              aria-label="Pencere bilgisini ekle"
              checked={current.includeWindowMetadata}
              disabled={isLoading || isSaving}
              onCheckedChange={(checked) => update({ includeWindowMetadata: checked })}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
