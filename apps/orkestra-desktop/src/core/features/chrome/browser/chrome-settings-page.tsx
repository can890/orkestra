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

// Ayarlar > Chrome: doğrudan bağlantı mimarisi. Köprü varsayılan olarak açıktır; manuel belirteç
// kopyalama veya site bazlı izin gerekmeden uzantıyla 127.0.0.1 üzerinden otomatik eşleşir.

const STATUS_QUERY_KEY = ['chrome', 'status'] as const;
const EXTENSION_QUERY_KEY = ['chrome', 'extension'] as const;
const EXTENSIONS_URL = 'chrome://extensions';

function errorMessage(error: ChromeError): string {
  return error.message;
}

function formatConnectionStatus(status: ChromeBridgeStatus | undefined): string {
  if (!status) return '…';
  if (!status.enabled) return 'Duraklatıldı';
  if (status.connected) return 'Uzantı bağlı';
  if (status.listening) return `Uzantı bekleniyor (127.0.0.1:${status.port})`;
  return 'Dinlemiyor';
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

  const connectionText = formatConnectionStatus(data);

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Chrome"
        description="Ajanların, kendi oturumlarınızla açık Chrome tarayıcınızı kullanması için doğrudan uzantı köprüsü. Varsayılan olarak açıktır."
      />

      {data?.listenError && (
        <Alert.Root status="warning">
          <Alert.Title>Köprü başlatılamadı</Alert.Title>
          <Alert.Description>{data.listenError}</Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="Köprü">
        <SettingsRow
          label="Chrome köprüsü"
          description={`Varsayılan olarak açıktır. Şu an: ${connectionText}.`}
          control={
            <Switch
              checked={data?.enabled ?? true}
              disabled={!data || configure.isPending}
              onCheckedChange={(next) => configure.mutate({ enabled: next })}
            />
          }
        />
        <SettingsRow
          label="Durum"
          description="Köprü açıkken yerel ve uzak (SSH) sohbetlerdeki ajanlar Chrome araçlarını doğrudan kullanabilir."
          control={
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground-muted">{connectionText}</span>
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
        <PortRow status={data} onSave={(port) => configure.mutate({ port })} />
        <SettingsRow
          label="Güvenlik"
          description="Köprü yalnızca bu bilgisayarda (127.0.0.1) dinler ve yalnızca Orkestra Chrome Köprüsü uzantısından gelen bağlantıları kabul eder. Yalnızca http/https sayfalarında çalışır; şifre ve ödeme kartı alanlarına dokunmaz."
          control={null}
        />
      </SettingsSection>

      <SetupSection />
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
      description="Uzantının bağlandığı yerel (127.0.0.1) bağlantı noktası."
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

function SetupSection() {
  const extension = useQuery({
    queryKey: EXTENSION_QUERY_KEY,
    queryFn: async (): Promise<ChromeExtensionInfo> => (await getChromeClient()).getExtensionInfo(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const info = extension.data;
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

  return (
    <SettingsSection title="Kurulum">
      <SettingsRow
        label="1. Uzantı klasörünü bulun"
        description={
          info && !info.available
            ? 'Uzantı klasörü bulunamadı. Uygulamayı yeniden kurmayı deneyin; depodan çalıştırıyorsanız apps/chrome-extension klasörünü kullanın.'
            : `Sovra ile birlikte gelir${info?.version ? ` (sürüm ${info.version})` : ''}. Konum: ${info?.path ?? '…'}`
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
        label="2. Uzantıyı Chrome'a yükleyin"
        description={
          chromeOpenFailed
            ? `Chrome açılamadı. Chrome'un adres çubuğuna ${EXTENSIONS_URL} yazın, ardından Geliştirici modu → Paketlenmemiş öğe yükle ve gösterilen klasörü seçin.`
            : `Chrome'da ${EXTENSIONS_URL} sayfasını açın, Geliştirici modu'nu etkinleştirin, Paketlenmemiş öğe yükle'yi seçin ve 1. adımdaki klasörü gösterin.`
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
        label="3. Doğrudan otomatik bağlantı"
        description="Uzantı yüklendiğinde belirteç kopyalamaya veya site bazlı izin vermeye gerek kalmadan masaüstü köprüsüne otomatik olarak bağlanır."
        control={null}
      />
    </SettingsSection>
  );
}
