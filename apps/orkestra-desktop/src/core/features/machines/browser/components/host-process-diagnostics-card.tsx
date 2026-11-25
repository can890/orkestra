import { SettingsCard } from '@orkestra/ui/react/patterns';
import { Badge, Button, toast } from '@orkestra/ui/react/primitives';
import { Activity, AlertTriangle, RefreshCw, Skull, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DevPerfProcess } from '@core/features/dev-perf/api';
import { getDevPerfClient } from '@core/features/dev-perf/api/browser/client';

const POLL_MS = 3_000;
const HIGH_CPU_THRESHOLD = 150;
const HIGH_RSS_THRESHOLD = 3 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

export function HostProcessDiagnosticsCard() {
  const [supported, setSupported] = useState(true);
  const [processes, setProcesses] = useState<DevPerfProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const client = await getDevPerfClient();
      const snap = await client.processSnapshot();
      setSupported(snap.supported);
      setProcesses(
        [...snap.processes].sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes)
      );
    } catch {
      // Başlangıç hatasını sessizce geç
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleSignal = async (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
    setBusyPid(pid);
    try {
      const client = await getDevPerfClient();
      const res = await client.signalProcess({ pid, signal });
      if (!res.success) {
        toast.error(`Süreç ${pid} durdurulamadı`, { description: res.error.message });
        return;
      }
      toast.success(`PID ${pid} süreç sinyali gönderildi (${signal})`);
      await refresh();
    } finally {
      setBusyPid(null);
    }
  };

  const totalCpu = processes.reduce((sum, p) => sum + p.cpuPercent, 0);
  const totalRss = processes.reduce((sum, p) => sum + p.rssBytes, 0);
  const overloaded = totalCpu > HIGH_CPU_THRESHOLD || totalRss > HIGH_RSS_THRESHOLD;

  return (
    <SettingsCard>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            <span className="text-sm font-medium text-foreground">
              Ana Süreç & Alt Süreç Tanılaması
            </span>
            {overloaded ? (
              <Badge variant="soft" tone="warning">
                <AlertTriangle className="mr-1 h-3 w-3" />
                Yüksek kaynak tüketimi
              </Badge>
            ) : (
              <Badge variant="soft" tone="neutral">
                {processes.length} süreç
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="tabular-nums">Toplam CPU: %{totalCpu.toFixed(1)}</span>
            <span className="tabular-nums">Toplam RAM: {formatBytes(totalRss)}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {!supported ? (
          <div className="text-muted-foreground text-xs">
            Bu işletim sisteminde süreç ağacı izlemesi desteklenmiyor.
          </div>
        ) : loading && processes.length === 0 ? (
          <div className="text-muted-foreground text-xs">Süreç ağacı okunuyor…</div>
        ) : (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="text-muted-foreground sticky top-0 bg-(--em-surface) text-[11px]">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">PID</th>
                  <th className="px-2.5 py-1.5 font-medium">Derinlik</th>
                  <th className="px-2.5 py-1.5 font-medium">CPU %</th>
                  <th className="px-2.5 py-1.5 font-medium">RAM</th>
                  <th className="px-2.5 py-1.5 font-medium">Komut</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">İşlem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {processes.slice(0, 35).map((proc) => (
                  <tr key={proc.pid} className="hover:bg-muted/30">
                    <td className="px-2.5 py-1.5 font-mono tabular-nums">{proc.pid}</td>
                    <td className="text-muted-foreground px-2.5 py-1.5">
                      {proc.depth === 0 ? 'Ana (0)' : `Alt (${proc.depth})`}
                    </td>
                    <td className="px-2.5 py-1.5 tabular-nums">%{proc.cpuPercent.toFixed(1)}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{formatBytes(proc.rssBytes)}</td>
                    <td className="max-w-[260px] truncate px-2.5 py-1.5 font-mono text-[11px]">
                      {proc.command}
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      {proc.depth > 0 ? (
                        <div className="inline-flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busyPid === proc.pid}
                            onClick={() => void handleSignal(proc.pid, 'SIGTERM')}
                            title="Nazikçe Durdur (SIGTERM)"
                          >
                            <Square className="h-3 w-3" />
                            SIGTERM
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busyPid === proc.pid}
                            onClick={() => void handleSignal(proc.pid, 'SIGKILL')}
                            title="Zorla Sonlandır (SIGKILL)"
                            className="text-red-400 hover:text-red-300"
                          >
                            <Skull className="h-3 w-3" />
                            SIGKILL
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">Korumalı</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
