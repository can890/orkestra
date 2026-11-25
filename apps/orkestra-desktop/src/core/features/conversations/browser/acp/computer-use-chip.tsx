import { Button, toast } from '@orkestra/ui/react/primitives';
import { MonitorUp, OctagonX } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  ComputerUseLogEntry,
  ComputerUsePermissionPane,
  ComputerUsePermissions,
} from '@core/features/computer-use/api';
import { getComputerUseClient } from '@core/features/computer-use/api/browser/client';
import { useComputerUseState } from '@core/features/computer-use/api/browser/use-computer-use-state';

/** Son eylemden sonra bandın "etkin" görünmeye devam ettiği süre. */
export const COMPUTER_USE_ACTIVE_GRACE_MS = 30_000;

/**
 * Bant yalnızca ajan gerçekten masaüstünü kullanıyorken belirgin olmalı: ajan çalışıyorsa ya da son
 * eylem az önce olduysa "etkin", aksi halde "boşta" (izin açık ama kullanılmıyor).
 */
export function isComputerUseActive(input: {
  working: boolean;
  lastActionAt: number | undefined;
  now: number;
}): boolean {
  if (input.working) return true;
  if (input.lastActionAt === undefined) return false;
  return input.now - input.lastActionAt < COMPUTER_USE_ACTIVE_GRACE_MS;
}

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

function MissingPermissionLinks({
  permissions,
  onOpenPane,
}: {
  permissions: ComputerUsePermissions;
  onOpenPane: (pane: ComputerUsePermissionPane) => void;
}) {
  return (
    <>
      {!permissions.accessibility ? (
        <button
          type="button"
          className="text-foreground underline"
          onClick={() => onOpenPane('accessibility')}
        >
          Erişilebilirlik
        </button>
      ) : null}
      {!permissions.accessibility && !permissions.screenRecording ? ', ' : null}
      {!permissions.screenRecording ? (
        <button
          type="button"
          className="text-foreground underline"
          title="Üstteki 'Ekran ve Sistem Sesi Kaydı' listesinde Sovra'yı açıp uygulamayı yeniden başlatın (alttaki 'Yalnızca Sistem Sesi Kaydı' değil)."
          onClick={() => onOpenPane('screen-recording')}
        >
          Ekran Kaydı
        </button>
      ) : null}
    </>
  );
}

/**
 * Yazı kutusunun üstünde: genel ayar açıkken yalnızca eksik izin uyarısı, aktif kullanım
 * kartı ("Durdur" + etkinlik günlüğü) veya kullanıcı bu sohbeti durdurduysa tek tıkla
 * yeniden açma hapı gösterir. Yeni/boş sohbette izinler tamken hiçbir şey çizmez.
 * macOS dışında, SSH projelerinde ve genel ayar kapalıyken hiçbir şey çizmez.
 */
export function ComputerUseChip({
  conversationId,
  remote,
  working,
}: {
  conversationId: string;
  remote: boolean;
  /** Ajan bu sohbette şu an çalışıyor mu? */
  working: boolean;
}) {
  const { state, setEnabled, stop } = useComputerUseState(conversationId);
  const [showLog, setShowLog] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastActionAt = state?.activity.at(-1)?.at;

  // Son eylemin üzerinden bekleme süresi geçince bandı "boşta" durumuna düşürmek için tek seferlik
  // zamanlayıcı (sürekli tik atan bir sayaç değil).
  useEffect(() => {
    setNow(Date.now());
    if (working || lastActionAt === undefined) return;
    const remaining = lastActionAt + COMPUTER_USE_ACTIVE_GRACE_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [working, lastActionAt]);

  if (!state || !state.supported || remote) return null;
  const { globalEnabled, conversationEnabled, permissions, activity } = state;
  if (!globalEnabled) return null;

  const missingPermission = !permissions.accessibility || !permissions.screenRecording;
  const openPane = (pane: ComputerUsePermissionPane) => {
    void getComputerUseClient().then((client) => client.openPermissionSettings({ pane }));
  };

  if (!conversationEnabled) {
    return (
      <button
        type="button"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm hover:text-foreground"
        onClick={() => {
          void setEnabled(true).then((result) => {
            if (!result.success) toast.error(result.error);
          });
        }}
      >
        <MonitorUp className="size-3" />
        Bilgisayar kullanımı bu sohbette durduruldu · Tekrar aç
      </button>
    );
  }

  if (activity.length === 0) {
    if (!missingPermission) return null;
    return (
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted shadow-sm">
        <MonitorUp className="size-3 shrink-0" />
        <span>
          macOS izni eksik:{' '}
          <MissingPermissionLinks permissions={permissions} onOpenPane={openPane} />
        </span>
      </div>
    );
  }

  const active = isComputerUseActive({ working, lastActionAt, now });

  // Ajan durduysa ve bir süredir eylem yoksa belirgin kırmızı bant yerine sessiz bir çip göster:
  // izin bu sohbette hâlâ açık, ama masaüstü şu an kullanılmıyor.
  if (!active && !expanded) {
    return (
      <button
        type="button"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-(--em-surface) px-2.5 py-1 text-xs text-foreground-muted hover:text-foreground"
        onClick={() => setExpanded(true)}
        aria-label="Masaüstü kontrolü ayrıntılarını göster"
      >
        <MonitorUp className="size-3" />
        Masaüstü kontrolü boşta · {activity.length} eylem
      </button>
    );
  }

  return (
    <div
      className={`pointer-events-auto w-80 space-y-2 rounded-lg border bg-(--em-surface) p-2.5 text-xs shadow-md ${
        active ? 'border-danger/60' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          {active ? (
            <span className="bg-danger relative inline-flex size-2 rounded-full" />
          ) : (
            <span className="relative inline-flex size-2 rounded-full bg-foreground-muted/50" />
          )}
        </span>
        <span className="flex-1 font-medium text-foreground">
          {active ? 'Masaüstü kontrolü açık' : 'Masaüstü kontrolü boşta'}
        </span>
        {!active ? (
          <button
            type="button"
            className="text-foreground-muted underline"
            onClick={() => setExpanded(false)}
          >
            Küçült
          </button>
        ) : null}
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
          <MissingPermissionLinks permissions={permissions} onOpenPane={openPane} />. İzni siz
          verin; ajan veremez.
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
