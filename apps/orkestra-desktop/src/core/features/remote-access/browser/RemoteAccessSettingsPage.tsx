import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Badge, Button, Switch, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getRemoteAccessClient } from '../api/browser/client';
import type {
  AccountPairingState,
  PairingResult,
  RemoteAccessState,
  RemoteDevice,
} from '../api/contract';
import { encodeQr, qrToSvgPath } from '../api/qr-code';

// Ayarlar > Mobil erişim: varsayılan kapalıdır. Açıkken telefon (aynı ağ ya da Tailscale)
// QR ile eşleşir; sohbetleri ve bağlı hesapları görür, sohbetleri sürdürür. Ajanlar ve token'lar
// bu bilgisayarda kalır; telefona yalnızca izinli bir Wire alt kümesi açılır.

const STATE_KEY = ['remote-access', 'state'] as const;
const ACCOUNT_PAIRING_KEY = ['remote-access', 'account-pairing'] as const;

async function fetchState(): Promise<RemoteAccessState> {
  return (await getRemoteAccessClient()).getState();
}

async function fetchAccountPairingState(): Promise<AccountPairingState> {
  return (await getRemoteAccessClient()).getAccountPairingState();
}

function formatClock(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleTimeString('tr-TR');
}

/** Durum satırı; her durum için Türkçe, eyleme dönük bir metin. */
function accountPairingStatusText(state: AccountPairingState): string {
  switch (state.status) {
    case 'off':
      return 'Kapalı.';
    case 'waiting-remote-access':
      return 'Mobil erişim açılınca başlar.';
    case 'no-account':
      return "Önce Ayarlar'dan bir GitHub hesabı bağlayın.";
    case 'missing-scope':
      return 'GitHub oturumunun gist izni yok. Terminalde `gh auth refresh -s gist` çalıştırıp hesabı yeniden içe aktarın.';
    case 'unauthorized':
      return 'GitHub oturumu geçersiz ya da süresi dolmuş. Hesabı yeniden bağlayın.';
    case 'error':
      return 'GitHub şu an yanıt vermiyor; kısa süre sonra yeniden denenecek.';
    case 'active':
      return `@${state.login ?? 'hesap'} hesabı izleniyor · son kontrol ${formatClock(state.lastCheckedAt)}`;
  }
}

function formatTime(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString('tr-TR');
}

export function RemoteAccessSettingsPage() {
  const queryClient = useQueryClient();
  // Sayfa açıkken durumu (cihaz bağlandı/eşleşti) 3 sn'de bir yenile.
  const state = useQuery({ queryKey: STATE_KEY, queryFn: fetchState, refetchInterval: 3000 });
  const accountPairing = useQuery({
    queryKey: ACCOUNT_PAIRING_KEY,
    queryFn: fetchAccountPairingState,
    refetchInterval: 3000,
  });
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: STATE_KEY });

  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await (await getRemoteAccessClient()).setEnabled({ enabled });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(STATE_KEY, data);
      if (!data.enabled) setPairing(null);
    },
    onError: (error) => toast.error('Mobil erişim değiştirilemedi', { description: error.message }),
  });

  const setAccountPairingEnabled = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await (await getRemoteAccessClient()).setAccountPairingEnabled({ enabled });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (data) => queryClient.setQueryData(ACCOUNT_PAIRING_KEY, data),
    onError: (error) =>
      toast.error('GitHub ile eşleşme değiştirilemedi', { description: error.message }),
  });

  const checkAccountPairing = useMutation({
    mutationFn: async () => (await getRemoteAccessClient()).checkAccountPairingNow(),
    onSuccess: (data) => queryClient.setQueryData(ACCOUNT_PAIRING_KEY, data),
    onError: (error) => toast.error('Kontrol edilemedi', { description: error.message }),
  });

  const createPairing = useMutation({
    mutationFn: async () => {
      const result = await (await getRemoteAccessClient()).createPairing();
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (data) => {
      setPairing(data);
      refresh();
    },
    onError: (error) => toast.error('Eşleştirme oluşturulamadı', { description: error.message }),
  });

  const removeDevice = useMutation({
    mutationFn: async (device: RemoteDevice) => {
      const client = await getRemoteAccessClient();
      const result =
        device.status === 'pending'
          ? await client.cancelPairing({ deviceId: device.id })
          : await client.revokeDevice({ deviceId: device.id });
      if (!result.success) throw new Error(result.error.message);
      return device;
    },
    onSuccess: (device) => {
      if (pairing?.deviceId === device.id) setPairing(null);
      refresh();
    },
    onError: (error) => toast.error('Cihaz kaldırılamadı', { description: error.message }),
  });

  const data = state.data;
  // Eşleşen/silinen cihaz için gösterilen QR'ı kapat. Yeni oluşturulan eşleştirme, cihaz listesi
  // yenilenene kadar listede görünmez; bu yüzden yalnızca listede en az bir kez "bekliyor" olarak
  // görüldükten sonra kaybolursa ya da durumu değişirse kapatılır.
  const pairingDevice = data?.devices.find((device) => device.id === pairing?.deviceId);
  const pairingStatus = pairingDevice?.status;
  const seenPendingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pairing) {
      seenPendingRef.current = null;
      return;
    }
    if (pairingStatus === 'pending') {
      seenPendingRef.current = pairing.deviceId;
      return;
    }
    const wasSeenPending = seenPendingRef.current === pairing.deviceId;
    if (pairingStatus !== undefined || wasSeenPending) setPairing(null);
  }, [pairing, pairingStatus]);

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Mobil erişim"
        description="Telefonunuzdan, aynı ağ ya da Tailscale üzerinden bu bilgisayardaki sohbetlere ve bağlı hesaplara bağlanın. Bulut yok: ajanlar ve token'lar bu bilgisayarda kalır."
      />

      {data && !data.secureStorageAvailable && (
        <Alert.Root status="warning">
          <Alert.Title>Güvenli depolama kullanılamıyor</Alert.Title>
          <Alert.Description>
            Eşleştirme sırları işletim sistemi anahtarlığında saklanır; bu sistemde yok, bu yüzden
            mobil erişim açılamaz.
          </Alert.Description>
        </Alert.Root>
      )}
      {data?.enabled && !data.listening && (
        <Alert.Root status="warning">
          <Alert.Title>Dinlenmiyor</Alert.Title>
          <Alert.Description>{data.lastError ?? 'Bağlantı noktası açılamadı.'}</Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="Geçit">
        <SettingsRow
          label="Mobil erişimi aç"
          description="Açıkken bu bilgisayar yerel ağda bir bağlantı noktası dinler. Yalnızca eşleştirdiğiniz telefonlar (şifreli bağlantı) erişebilir. Kapalıyken hiçbir port açılmaz."
          control={
            <Switch
              aria-label="Mobil erişimi aç"
              checked={data?.enabled ?? false}
              disabled={!data || setEnabled.isPending || !data.secureStorageAvailable}
              onCheckedChange={(checked) => setEnabled.mutate(checked)}
            />
          }
        />
        {data?.enabled && data.listening && (
          <SettingsRow
            label="Adres"
            description={
              data.addresses.length > 0
                ? `${data.addresses.join(', ')} · port ${data.port}`
                : 'Telefonun erişebileceği bir ağ adresi bulunamadı (Wi-Fi ya da Tailscale bağlı mı?).'
            }
            control={null}
          />
        )}
      </SettingsSection>

      <SettingsSection title="GitHub hesabıyla eşleş">
        <SettingsRow
          label="GitHub hesabıyla eşleş"
          description="Açıkken bu bilgisayar, GitHub hesabınızdaki gizli bir gist'e açık anahtarını ve yerel ağ adreslerini yazar. Aynı GitHub hesabıyla giriş yapan telefonlar QR okutmadan eşleşir. Gist'e eşleştirme sırrı yazılmaz."
          control={
            <Switch
              aria-label="GitHub hesabıyla eşleş"
              checked={accountPairing.data?.enabled ?? false}
              disabled={
                // Mobil erişim kapalıyken açılamaz; ama açık kalmış ayar yine kapatılabilir.
                (!data?.enabled && !accountPairing.data?.enabled) ||
                !accountPairing.data ||
                setAccountPairingEnabled.isPending
              }
              onCheckedChange={(checked) => setAccountPairingEnabled.mutate(checked)}
            />
          }
        />
        {accountPairing.data?.enabled && (
          <SettingsRow
            label="Durum"
            description={accountPairingStatusText(accountPairing.data)}
            control={
              <Button
                size="sm"
                variant="secondary"
                disabled={checkAccountPairing.isPending}
                onClick={() => checkAccountPairing.mutate()}
              >
                Şimdi kontrol et
              </Button>
            }
          />
        )}
        {accountPairing.data?.enabled && accountPairing.data.lastPairedDeviceName && (
          <SettingsRow
            label="Son eşleşen"
            description={accountPairing.data.lastPairedDeviceName}
            control={null}
          />
        )}
      </SettingsSection>

      {data?.enabled && data.listening && (
        <SettingsSection title="Telefon eşleştir">
          <SettingsRow
            label="Yeni telefon"
            description="Android uygulamasında QR'ı okutun. Kod 10 dakika geçerlidir ve gizli anahtar içerir; kimseyle paylaşmayın."
            control={
              <Button
                size="sm"
                disabled={createPairing.isPending}
                onClick={() => createPairing.mutate()}
              >
                QR kodu oluştur
              </Button>
            }
          />
          {pairing && <PairingCode pairing={pairing} />}
        </SettingsSection>
      )}

      <SettingsSection title="Eşleşmiş cihazlar">
        {data && data.devices.length === 0 && (
          <SettingsRow
            label="Cihaz yok"
            description="Henüz eşleşmiş bir telefon yok."
            control={null}
          />
        )}
        {data?.devices.map((device) => (
          <SettingsRow
            key={device.id}
            label={
              <span className="inline-flex items-center gap-2">
                {device.name}
                {device.status === 'pending' && <Badge>Bekliyor</Badge>}
                {device.connected && <Badge>Bağlı</Badge>}
              </span>
            }
            description={
              device.status === 'pending'
                ? `Geçerlilik sonu: ${formatTime(device.expiresAt)}`
                : `${device.platform ?? 'Bilinmeyen platform'} · son görülme ${formatTime(device.lastSeenAt)}`
            }
            control={
              <Button
                size="sm"
                variant="destructive"
                disabled={removeDevice.isPending}
                onClick={() => removeDevice.mutate(device)}
              >
                {device.status === 'pending' ? 'Vazgeç' : 'Erişimi iptal et'}
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </div>
  );
}

function PairingCode({ pairing }: { pairing: PairingResult }) {
  const qr = useMemo(() => {
    try {
      const { d, viewSize } = qrToSvgPath(encodeQr(pairing.payload));
      return { d, viewSize };
    } catch {
      return null;
    }
  }, [pairing.payload]);

  return (
    <div className="flex flex-col items-start gap-3 px-1 py-2">
      {qr ? (
        // Beyaz zemin tema fark etmeksizin tarayıcı doğruluğu için gerekli.
        <svg
          role="img"
          aria-label="Eşleştirme QR kodu"
          viewBox={`0 0 ${qr.viewSize} ${qr.viewSize}`}
          className="size-56 rounded-md bg-white"
          shapeRendering="crispEdges"
        >
          <path d={qr.d} fill="#000" />
        </svg>
      ) : (
        <p className="text-sm text-foreground-warning">QR kodu çizilemedi; kodu elle girin.</p>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard
            .writeText(pairing.payload)
            .then(() => toast.success('Eşleştirme kodu kopyalandı'));
        }}
      >
        Kodu kopyala (elle giriş için)
      </Button>
    </div>
  );
}
