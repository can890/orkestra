import { Button, toast } from '@orkestra/ui/react/primitives';
import { MonitorUp, OctagonX } from 'lucide-react';
import { useState } from 'react';
import type { ComputerUseLogEntry } from '@core/features/computer-use/api';
import { getComputerUseClient } from '@core/features/computer-use/api/browser/client';
import { useComputerUseState } from '@core/features/computer-use/api/browser/use-computer-use-state';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('tr-TR');
}

function ActivityList({ entries }: { entries: ComputerUseLogEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-foreground-muted">Henüz bir eylem yok.</p>;
  }
  return (
    <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-[11px] text-foreground-muted">
      {[...entries].reverse().map((entry) => (
        <li key={`${entry.at}-${entry.tool}-${entry.summary}`}>
          {formatTime(entry.at)} {entry.summary}
          {entry.outcome === 'ok' ? '' : ` [${entry.outcome === 'denied' ? 'reddedildi' : 'hata'}]`}
        </li>
      ))}
    </ul>
  );
}

/**
 * Yazı kutusunun üstünde: bilgisayar kullanımı bu sohbette etkinse kalıcı gösterge ve tek
 * tıkla "Durdur"; genel ayar açıksa ve sohbet etkin değilse açık onaylı etkinleştirme.
 * macOS dışında, SSH projelerinde ve genel ayar kapalıyken hiçbir şey çizmez.
 */
export function ComputerUseChip({
  conversationId,
  remote,
}: {
  conversationId: string;
  remote: boolean;
}) {
  const { state, setEnabled, stop } = useComputerUseState(conversationId);
  const [confirming, setConfirming] = useState(false);
  const [showLog, setShowLog] = useState(false);

  if (!state || !state.supported || remote) return null;
  const { globalEnabled, conversationEnabled, permissions, activity } = state;
  if (!globalEnabled && !conversationEnabled) return null;

  const missingPermission = !permissions.accessibility || !permissions.screenRecording;
  const openPane = (pane: 'accessibility' | 'screen-recording') => {
    void getComputerUseClient().then((client) => client.openPermissionSettings({ pane }));
  };

  if (!conversationEnabled) {
    if (!confirming) {
      return (
        <button
          type="button"
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm hover:text-foreground"
          onClick={() => setConfirming(true)}
        >
          <MonitorUp className="size-3" />
          Bilgisayar kullanımını bu sohbette aç
        </button>
      );
    }
    return (
      <div className="pointer-events-auto w-80 space-y-2 rounded-lg border border-border bg-(--em-surface) p-3 text-xs shadow-md">
        <p className="font-medium text-foreground">Ajan masaüstünüzü görüp kontrol edebilsin mi?</p>
        <p className="text-foreground-muted">
          Ajan ekran görüntüsü alabilir, fareyi ve klavyeyi kullanabilir. Ekranınızdaki her şeyi
          (açık pencereler, bildirimler) görebilir. Her eylem günlüğe yazılır ve istediğiniz anda
          Durdur ile kesebilirsiniz. Araçlar ajana yeni oturum başladığında eklenir; sohbet zaten
          çalışıyorsa yeniden başlatmanız gerekebilir.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Vazgeç
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConfirming(false);
              void setEnabled(true).then((result) => {
                if (!result.success) toast.error(result.error);
              });
            }}
          >
            Etkinleştir
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-danger/60 pointer-events-auto w-80 space-y-2 rounded-lg border bg-(--em-surface) p-2.5 text-xs shadow-md">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          <span className="bg-danger absolute inline-flex size-full animate-ping rounded-full opacity-60" />
          <span className="bg-danger relative inline-flex size-2 rounded-full" />
        </span>
        <span className="flex-1 font-medium text-foreground">
          {globalEnabled ? 'Masaüstü kontrolü açık' : 'Genel ayar kapalı: araçlar çalışmaz'}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void stop()}
          aria-label="Bilgisayar kullanımını durdur"
        >
          <OctagonX className="size-3" />
          Durdur
        </Button>
      </div>
      {missingPermission ? (
        <p className="text-foreground-muted">
          macOS izni eksik:{' '}
          {!permissions.accessibility ? (
            <button type="button" className="underline" onClick={() => openPane('accessibility')}>
              Erişilebilirlik
            </button>
          ) : null}
          {!permissions.accessibility && !permissions.screenRecording ? ', ' : null}
          {!permissions.screenRecording ? (
            <button
              type="button"
              className="underline"
              onClick={() => openPane('screen-recording')}
            >
              Ekran Kaydı
            </button>
          ) : null}
          . İzni siz verin; ajan veremez.
        </p>
      ) : null}
      <button
        type="button"
        className="text-foreground-muted underline"
        onClick={() => setShowLog((value) => !value)}
      >
        {showLog ? 'Günlüğü gizle' : `Etkinlik günlüğü (${activity.length})`}
      </button>
      {showLog ? <ActivityList entries={activity} /> : null}
    </div>
  );
}
