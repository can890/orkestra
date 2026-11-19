import { Button, Input, Switch } from '@orkestra/ui/react/primitives';
import { Moon, Play, RefreshCcw, Square, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { SimulatorDevice, SimulatorError } from '@core/features/simulator/api';
import { getSimulatorClient } from '@core/features/simulator/api/browser/client';
import { createScreenshotPoller } from './screenshot-poller';

const STATE_LABELS: Record<SimulatorDevice['state'], string> = {
  booted: 'Açık',
  shutdown: 'Kapalı',
  booting: 'Açılıyor',
  'shutting-down': 'Kapanıyor',
  unknown: 'Bilinmiyor',
};

type Outcome = { success: true } | { success: false; error: SimulatorError };

/**
 * Sekme görünürken bağlanan canlı görüntü. Bileşen yalnızca sekme etkinken bağlı olduğundan
 * yoklama sekme kapanınca ya da başka sekmeye geçilince durur.
 */
function useLiveScreen(udid: string | null) {
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFrame(null);
    setError(null);
    if (!udid) return;
    const poller = createScreenshotPoller({
      capture: async () => {
        const client = await getSimulatorClient();
        const result = await client.screenshot({ udid });
        return result.success
          ? { success: true, data: result.data }
          : { success: false, message: result.error.message };
      },
      onFrame: (url) => {
        setFrame(url);
        setError(null);
      },
      onError: setError,
      isVisible: () => document.visibilityState === 'visible',
    });
    poller.start();
    return () => poller.stop();
  }, [udid]);

  return { frame, error };
}

export function SimulatorPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<SimulatorDevice[]>([]);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [appPath, setAppPath] = useState('');
  const [bundleId, setBundleId] = useState('');
  const { value: settings, update, isLoading, isSaving } = useAppSettingsKey('simulator');

  const selected = useMemo(
    () => devices.find((device) => device.udid === selectedUdid) ?? null,
    [devices, selectedUdid]
  );
  const liveUdid = selected?.state === 'booted' ? selected.udid : null;
  const { frame, error: frameError } = useLiveScreen(liveUdid);

  const refresh = useCallback(async () => {
    const client = await getSimulatorClient();
    const result = await client.listDevices();
    if (!result.success) {
      setMessage({ tone: 'error', text: result.error.message });
      return;
    }
    setDevices(result.data);
    setSelectedUdid((current) => {
      if (current && result.data.some((device) => device.udid === current)) return current;
      return result.data.find((device) => device.state === 'booted')?.udid ?? null;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const client = await getSimulatorClient();
      const availability = await client.availability();
      setSupported(availability.supported);
      if (availability.supported) await refresh();
    })();
  }, [refresh]);

  const run = async (label: string, action: () => Promise<Outcome>, successText?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      const outcome = await action();
      if (!outcome.success) setMessage({ tone: 'error', text: outcome.error.message });
      else if (successText) setMessage({ tone: 'info', text: successText });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const withClient = async <T,>(
    call: (client: Awaited<ReturnType<typeof getSimulatorClient>>) => Promise<T>
  ) => call(await getSimulatorClient());

  if (supported === false) {
    return (
      <div className="p-6 text-sm text-foreground-muted">
        iOS Simülatör yalnızca macOS üzerinde kullanılabilir.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">iOS Simülatör</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => void run('refresh', async () => (await refresh(), { success: true }))}
        >
          <RefreshCcw className="size-3.5" />
          Yenile
        </Button>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-border p-2">
        <span className="flex flex-col">
          <span>Ajanın simülatörü kullanmasına izin ver</span>
          <span className="text-xs text-foreground-muted">
            Açıkken yeni sohbetlerde ajan cihazları listeleyebilir, ekran görüntüsü alabilir, URL
            açabilir, uygulama kurup başlatabilir. Çalışan sohbetler için yeniden başlatma gerekir.
          </span>
        </span>
        <Switch
          checked={settings?.agentToolsEnabled ?? false}
          disabled={isLoading || isSaving}
          onCheckedChange={(next) => update({ agentToolsEnabled: next })}
        />
      </label>

      {message ? (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error' ? 'text-foreground-destructive' : 'text-foreground-muted'
          }
        >
          {message.text}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        {devices.length === 0 && supported ? (
          <div className="text-foreground-muted">
            Kullanılabilir simülatör bulunamadı. Xcode'da bir iOS çalışma zamanı kurulu olmalı.
          </div>
        ) : null}
        {devices.map((device) => (
          <div
            key={device.udid}
            className={`flex items-center gap-2 rounded-md border p-2 ${
              device.udid === selectedUdid ? 'border-border-focus' : 'border-border'
            }`}
          >
            <button
              type="button"
              className="flex flex-1 flex-col text-left"
              onClick={() => setSelectedUdid(device.udid)}
            >
              <span>{device.name}</span>
              <span className="text-xs text-foreground-muted">
                {device.runtime} · {STATE_LABELS[device.state]}
              </span>
            </button>
            {device.state === 'booted' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run('shutdown', async () => {
                    const outcome = await withClient((client) =>
                      client.shutdownDevice({ udid: device.udid })
                    );
                    await refresh();
                    return outcome;
                  })
                }
              >
                <Square className="size-3.5" />
                Kapat
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null || device.state !== 'shutdown'}
                onClick={() =>
                  void run('boot', async () => {
                    const outcome = await withClient((client) =>
                      client.bootDevice({ udid: device.udid })
                    );
                    setSelectedUdid(device.udid);
                    await refresh();
                    return outcome;
                  })
                }
              >
                <Play className="size-3.5" />
                Başlat
              </Button>
            )}
          </div>
        ))}
      </div>

      {selected && liveUdid ? (
        <div className="flex flex-col gap-3">
          <div className="bg-surface flex justify-center rounded-md border border-border p-2">
            {frame ? (
              <img
                src={frame}
                alt={`${selected.name} ekranı`}
                className="max-h-[60vh] w-auto rounded"
                draggable={false}
              />
            ) : (
              <span className="p-8 text-foreground-muted">Görüntü bekleniyor…</span>
            )}
          </div>
          {frameError ? <div className="text-foreground-destructive">{frameError}</div> : null}
          <p className="text-xs text-foreground-muted">
            Dokunma ve klavye girişi desteklenmez: simctl ile kullanıcı girdisi gönderilemez, bu
            yüzden ne siz ne de ajan simülatörde dokunabilir ya da yazabilir. URL açarak ve uygulama
            başlatarak gezinin.
          </p>

          <div className="flex gap-2">
            <Input
              value={url}
              placeholder="https://example.com ya da uygulama://yol"
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy !== null || url.trim().length === 0}
              onClick={() =>
                void run(
                  'url',
                  () => withClient((client) => client.openUrl({ udid: liveUdid, url: url.trim() })),
                  'URL simülatörde açıldı.'
                )
              }
            >
              URL aç
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              value={appPath}
              placeholder="/yol/Uygulama.app (derlenmiş paket)"
              onChange={(event) => setAppPath(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy !== null || appPath.trim().length === 0}
              onClick={() =>
                void run(
                  'install',
                  () =>
                    withClient((client) =>
                      client.installApp({ udid: liveUdid, appPath: appPath.trim() })
                    ),
                  'Uygulama kuruldu.'
                )
              }
            >
              Kur
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              value={bundleId}
              placeholder="com.ornek.Uygulama (bundle id)"
              onChange={(event) => setBundleId(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy !== null || bundleId.trim().length === 0}
              onClick={() =>
                void run(
                  'launch',
                  () =>
                    withClient((client) =>
                      client.launchApp({ udid: liveUdid, bundleId: bundleId.trim() })
                    ),
                  'Uygulama başlatıldı.'
                )
              }
            >
              Başlat
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                void run('light', () =>
                  withClient((client) =>
                    client.setAppearance({ udid: liveUdid, appearance: 'light' })
                  )
                )
              }
            >
              <Sun className="size-3.5" />
              Açık görünüm
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() =>
                void run('dark', () =>
                  withClient((client) =>
                    client.setAppearance({ udid: liveUdid, appearance: 'dark' })
                  )
                )
              }
            >
              <Moon className="size-3.5" />
              Koyu görünüm
            </Button>
          </div>
        </div>
      ) : selected ? (
        <div className="text-foreground-muted">
          Canlı görüntü için "{selected.name}" cihazını başlatın.
        </div>
      ) : null}
    </div>
  );
}
