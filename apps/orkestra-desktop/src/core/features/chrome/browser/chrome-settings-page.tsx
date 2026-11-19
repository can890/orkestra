import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Button, Input, Switch, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getChromeClient } from '@core/features/chrome/api/browser/client';
import {
  DEFAULT_CHROME_BRIDGE_PORT,
  type ChromeBridgeStatus,
  type ChromeExtensionInfo,
  type ChromeError,
} from '@core/features/chrome/api/contract';
import { copyTextToClipboard } from '@core/primitives/desktop-host/browser/host-client';

// Ayarlar > Chrome: köprüyü aç/kapat (varsayılan kapalı), bağlantı noktası, eşleştirme belirteci
// (kopyala / yenile) ve bağlantı durumu. Belirteç yalnızca kullanıcı isteyince getirilir.

const STATUS_QUERY_KEY = ['chrome', 'status'] as const;
const EXTENSION_QUERY_KEY = ['chrome', 'extension'] as const;

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

      <SetupSection status={data} configure={configure} onTokenCopied={refresh} />

      <SettingsSection title="Köprü">
        <SettingsRow
          label="Güvenlik"
          description="Açıkken köprü yalnızca bu bilgisayarda (127.0.0.1) dinler ve yalnızca eşleştirme belirtecini bilen Chrome uzantısını kabul eder."
          control={null}
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

function useCopyToken(onChanged: () => void) {
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

  return { busy, copy };
}

function TokenRow({ onChanged }: { onChanged: () => void }) {
  const { busy, copy } = useCopyToken(onChanged);

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

const EXTENSIONS_URL = 'chrome://extensions';

function SetupSection({
  status,
  configure,
  onTokenCopied,
}: {
  status: ChromeBridgeStatus | undefined;
  configure: { mutate: (patch: { enabled?: boolean }) => void; isPending: boolean };
  onTokenCopied: () => void;
}) {
  const extension = useQuery({
    queryKey: EXTENSION_QUERY_KEY,
    queryFn: async (): Promise<ChromeExtensionInfo> => (await getChromeClient()).getExtensionInfo(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const info = extension.data;
  const { busy, copy } = useCopyToken(onTokenCopied);
  const [chromeOpenFailed, setChromeOpenFailed] = useState(false);

  const reveal = useMutation({
    mutationFn: async () => (await getChromeClient()).revealExtensionFolder(),
    onSuccess: (result) => {
      if (!result.revealed) toast.error('Uzantı klasörü gösterilemedi');
    },
    onError: (error) => toast.error('Uzantı klasörü gösterilemedi', { description: error.message }),
  });
  const openExtensions = useMutation({
    mutationFn: async () => (await getChromeClient()).openChromeExtensionsPage(),
    onSuccess: (result) => setChromeOpenFailed(!result.opened),
    onError: () => setChromeOpenFailed(true),
  });

  const connectionText = !status
    ? '…'
    : !status.enabled
      ? 'Köprü kapalı'
      : status.connected
        ? 'Uzantı bağlı'
        : status.listening
          ? 'Uzantı bekleniyor'
          : 'Dinlemiyor';

  return (
    <SettingsSection title="Kurulum">
      <SettingsRow
        label="1. Chrome köprüsünü açın"
        description={`Varsayılan olarak kapalıdır. Şu an: ${connectionText}.`}
        control={
          <Switch
            checked={status?.enabled ?? false}
            disabled={!status || configure.isPending || !status.secureStorageAvailable}
            onCheckedChange={(next) => configure.mutate({ enabled: next })}
          />
        }
      />
      <SettingsRow
        label="2. Uzantı klasörünü bulun"
        description={
          info && !info.available
            ? 'Uzantı klasörü bulunamadı. Uygulamayı yeniden kurmayı deneyin; depodan çalıştırıyorsanız apps/chrome-extension klasörünü kullanın.'
            : `Orkestra ile birlikte gelir${info?.version ? ` (sürüm ${info.version})` : ''}. Konum: ${info?.path ?? '…'}`
        }
        control={
          <Button
            variant="secondary"
            size="sm"
            disabled={!info?.available || reveal.isPending}
            onClick={() => reveal.mutate()}
          >
            Uzantı klasörünü göster
          </Button>
        }
      />
      <SettingsRow
        label="3. Uzantıyı Chrome'a yükleyin"
        description={
          chromeOpenFailed
            ? `Chrome açılamadı. Chrome'un adres çubuğuna ${EXTENSIONS_URL} yazın, ardından Geliştirici modu → Paketlenmemiş öğe yükle ve gösterilen klasörü seçin.`
            : `Chrome'da ${EXTENSIONS_URL} sayfasını açın, Geliştirici modu'nu etkinleştirin, Paketlenmemiş öğe yükle'yi seçin ve 2. adımdaki klasörü gösterin.`
        }
        control={
          <Button
            variant="secondary"
            size="sm"
            disabled={openExtensions.isPending}
            onClick={() => openExtensions.mutate()}
          >
            Chrome uzantılar sayfasını aç
          </Button>
        }
      />
      <SettingsRow
        label="4. Belirteci uzantıya yapıştırın"
        description="Belirteci kopyalayın; uzantı simgesi → Ayarlar sayfasında belirteci yapıştırın, bağlantı noktasının aşağıdakiyle aynı olduğunu doğrulayın ve Kaydet ve bağlan'a basın."
        control={
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void copy('reveal')}>
            Belirteci kopyala
          </Button>
        }
      />
      <SettingsRow
        label="5. Siteye izin verin"
        description="Ajanın kullanacağı sitede uzantı simgesine tıklayıp Bu siteye izin ver'e basın; izin vermediğiniz sitelerde ajan işlem yapamaz. Köprü açık ve uzantı bağlıyken yeni başlayan sohbetlere Chrome araçları eklenir; açık sohbetler etkilenmez."
        control={null}
      />
    </SettingsSection>
  );
}
