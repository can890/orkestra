import { SettingsSection } from '@orkestra/ui/react/patterns';
import { Button, Switch } from '@orkestra/ui/react/primitives';
import { useEffect, useState } from 'react';
import { getComputerUseClient } from '@core/features/computer-use/api/browser/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { SettingRow } from './SettingRow';

const TITLE = 'Bilgisayar kullanımı';

/**
 * Genel kilit: ajanlara masaüstünü görme ve kontrol etme yetkisi veren araçların varsayılan
 * kapalı ana şalteri. Açıldığında tüm yerel sohbetlerde otomatik olarak etkinleşir; istenirse
 * aktif sohbette tek tıkla durdurulabilir. Yalnızca macOS'ta gösterilir.
 */
export function ComputerUseSettingsSection() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('computerUse');
  const [permissions, setPermissions] = useState<{
    accessibility: boolean;
    screenRecording: boolean;
  } | null>(null);
  const isMac = detectPlatformContext().os === 'mac';

  useEffect(() => {
    if (!isMac || !value?.enabled) return;
    let cancelled = false;
    const refresh = () => {
      void getComputerUseClient()
        .then((client) => client.getState({ conversationId: 'settings' }))
        .then((state) => {
          if (!cancelled) setPermissions(state.permissions);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [isMac, value?.enabled]);

  if (!isMac) return null;
  const openPane = (pane: 'accessibility' | 'screen-recording') => {
    void getComputerUseClient().then((client) => client.openPermissionSettings({ pane }));
  };

  const baseStatus = `Erişilebilirlik: ${permissions?.accessibility ? 'verildi' : 'yok'}. Ekran Kaydı: ${permissions?.screenRecording ? 'verildi' : 'yok'}.`;
  const permissionDescription =
    permissions && !permissions.screenRecording
      ? `${baseStatus} Ekran Kaydı için üstteki "Ekran ve Sistem Sesi Kaydı" listesinde (alttaki "Yalnızca Sistem Sesi Kaydı" değil) Orkestra'yı açıp uygulamayı yeniden başlatın.`
      : `${baseStatus} İzinleri yalnızca siz Sistem Ayarları'ndan verebilirsiniz.`;

  return (
    <SettingsSection title="Bilgisayar kullanımı">
      <SettingRow
        title={TITLE}
        description="Açıkken ajanlar tüm yerel sohbetlerde otomatik olarak ekran görüntüsü alabilir ve fareyi/klavyeyi kullanabilir. Yüksek risklidir: ekranınızdaki her şeyi görebilirler. Varsayılan kapalıdır; istediğiniz zaman aktif sohbette tek tıkla durdurabilirsiniz."
        control={
          <Switch
            aria-label={TITLE}
            checked={value?.enabled ?? false}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />
      {value?.enabled ? (
        <SettingRow
          title="macOS izinleri"
          description={permissionDescription}
          control={
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => openPane('accessibility')}>
                Erişilebilirlik
              </Button>
              <Button variant="secondary" size="sm" onClick={() => openPane('screen-recording')}>
                Ekran Kaydı
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
