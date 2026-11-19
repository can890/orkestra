import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Button, Input, Switch, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getChromeClient } from '@core/features/chrome/api/browser/client';
import {
  DEFAULT_CHROME_BRIDGE_PORT,
  type ChromeBridgeStatus,
  type ChromeError,
} from '@core/features/chrome/api/contract';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';

// Ayarlar > Chrome: köprüyü aç/kapat (varsayılan kapalı), bağlantı noktası, eşleştirme belirteci
// (kopyala / yenile) ve bağlantı durumu. Belirteç yalnızca kullanıcı isteyince getirilir.

const STATUS_QUERY_KEY = ['chrome', 'status'] as const;

function errorMessage(error: ChromeError): string {
  return error.message;
}

export function ChromeSettingsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: async (): Promise<ChromeBridgeStatus> => (await getChromeClient()).getStatus(),
    refetchInterval: 2000,
  });
  const data = status.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });

  const configure = useMutation({
    mutationFn: async (patch: { enabled?: boolean; port?: number }) => {
      const result = await (await getChromeClient()).configure(patch);
      if (!result.success) throw new Error(errorMessage(result.error));
      return result.data;
    },
    onSuccess: refresh,
    onError: (error) => toast.error('Chrome ayarı kaydedilemedi', { description: error.message }),
  });

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Chrome"
        description="Ajanların, kendi oturumlarınızla açık Chrome'unuzu kullanması için uzantı köprüsü. Varsayılan olarak kapalıdır."
      />

      {data && !data.secureStorageAvailable && (
        <Alert.Root status="warning">
          <Alert.Title>Güvenli depolama kullanılamıyor</Alert.Title>
          <Alert.Description>
            Bu sistemde şifreli anahtar deposu yok; eşleştirme belirteci saklanamaz, köprü açılamaz.
          </Alert.Description>
        </Alert.Root>
      )}
      {data?.listenError && (
        <Alert.Root status="warning">
          <Alert.Title>Köprü başlatılamadı</Alert.Title>
          <Alert.Description>{data.listenError}</Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="Köprü">
        <SettingsRow
          label="Chrome köprüsü"
          description="Açıkken yalnızca bu bilgisayarda (127.0.0.1) dinler ve yalnızca eşleştirme belirtecini bilen Chrome uzantısını kabul eder."
          control={
            <Switch
              checked={data?.enabled ?? false}
              disabled={!data || configure.isPending || !data.secureStorageAvailable}
              onCheckedChange={(next) => configure.mutate({ enabled: next })}
            />
          }
        />
        <PortRow status={data} onSave={(port) => configure.mutate({ port })} />
        <SettingsRow
          label="Durum"
          description="Ajan araçları yalnızca köprü açıkken ve uzantı bağlıyken yeni sohbetlere eklenir."
          control={
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground-muted">
                {!data
                  ? '…'
                  : !data.enabled
                    ? 'Kapalı'
                    : data.connected
                      ? 'Uzantı bağlı'
                      : data.listening
                        ? 'Uzantı bekleniyor'
                        : 'Dinlemiyor'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!data?.connected}
                onClick={() => {
                  void getChromeClient().then((client) => client.disconnect());
                  refresh();
                }}
              >
                Bağlantıyı kes
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Eşleştirme">
        <TokenRow onChanged={refresh} />
        <SettingsRow
          label="Kurulum"
          description="chrome://extensions → Geliştirici modu → Paketlenmemiş öğe yükle → apps/chrome-extension klasörü. Uzantı ayarlarına belirteci yapıştırın, ardından ajanın kullanacağı siteye uzantıdan izin verin."
          control={null}
        />
      </SettingsSection>
    </div>
  );
}

function PortRow({
  status,
  onSave,
}: {
  status: ChromeBridgeStatus | undefined;
  onSave: (port: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(status?.port ?? DEFAULT_CHROME_BRIDGE_PORT);
  const port = Number(shown);
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  return (
    <SettingsRow
      label="Bağlantı noktası"
      description="Uzantı seçeneklerindeki bağlantı noktasıyla aynı olmalıdır."
      control={
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              onSave(port);
              setDraft(null);
            }
          }}
        >
          <Input
            inputMode="numeric"
            aria-label="Bağlantı noktası"
            value={shown}
            onChange={(event) => setDraft(event.target.value)}
            className="w-[100px]"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!valid || draft === null}>
            Kaydet
          </Button>
        </form>
      }
    />
  );
}

function TokenRow({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const copy = async (mode: 'reveal' | 'rotate') => {
    setBusy(true);
    try {
      const client = await getChromeClient();
      const result = await (mode === 'rotate' ? client.rotateToken() : client.revealToken());
      if (!result.success) {
        toast.error('Belirteç alınamadı', { description: errorMessage(result.error) });
        return;
      }
      const copied = await copyTextToClipboard(result.data.token);
      if (copied.success) {
        toast.success(
          mode === 'rotate'
            ? 'Yeni belirteç panoya kopyalandı; eski belirteç geçersiz.'
            : 'Belirteç panoya kopyalandı'
        );
      } else {
        toast.error('Belirteç panoya kopyalanamadı');
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      label="Eşleştirme belirteci"
      description="Belirteç şifreli saklanır; ekranda gösterilmez, yalnızca panoya kopyalanır. Yenilemek eski belirteci ve bağlı uzantıyı hemen geçersiz kılar."
      control={
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void copy('reveal')}>
            Kopyala
          </Button>
          <Button
            variant="ghost"
            tone="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void copy('rotate')}
          >
            Yenile
          </Button>
        </div>
      }
    />
  );
}
