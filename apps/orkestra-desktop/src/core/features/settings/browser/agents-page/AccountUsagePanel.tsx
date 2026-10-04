import type { HostRef } from '@orkestra/core/primitives/host/api';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { getAgentsClient, unwrapAgentsResult } from '@core/features/agents/api/browser/client';

const providers = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['kimi', 'Kimi'],
  ['glm', 'GLM / Z.ai'],
  ['antigravity', 'Antigravity'],
  ['grok', 'Grok'],
] as const;
const format = (value: number) => value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
function UsageCard({ host, id, name }: { host: HostRef; id: string; name: string }) {
  const query = useQuery({
    queryKey: ['agents', 'account-usage', host.type, host.id, id],
    queryFn: async () =>
      unwrapAgentsResult((await getAgentsClient()).accountUsage({ host, providerId: id })),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-sm">{name}</strong>
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground disabled:opacity-50"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Sorgulanıyor…' : 'Yenile'}
        </button>
      </div>
      {data?.account && (
        <div className="text-muted-foreground text-xs break-all">{data.account}</div>
      )}
      {query.isError ? (
        <p className="text-destructive text-sm">
          Kullanım verisine ulaşılamadı. Makine bağlantısını kontrol edin.
        </p>
      ) : !data ? (
        <p className="text-muted-foreground text-sm">Gerçek hesap verisi sorgulanıyor…</p>
      ) : (
        <>
          {data.status !== 'available' && (
            <p className="text-sm font-medium">
              {data.status === 'auth-required' ? 'Hesap erişimi gerekli' : 'Veri alınamıyor'}
            </p>
          )}
          {data.windows.map((w, index) => (
            <div key={`${w.label}-${index}`} className="space-y-1">
              <div className="flex justify-between gap-2 text-xs">
                <span>{w.label}</span>
                <span className="font-medium whitespace-nowrap">
                  %{format(w.remainingPercent)} kaldı
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`${name} ${w.label} kalan kota`}
                aria-valuenow={w.remainingPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="bg-muted h-1.5 overflow-hidden rounded-full"
              >
                <div
                  className={
                    w.remainingPercent <= 10 ? 'bg-destructive h-full' : 'h-full bg-emerald-500'
                  }
                  style={{ width: `${w.remainingPercent}%` }}
                />
              </div>
              {w.resetsAt && (
                <p className="text-muted-foreground text-xs">
                  Yenilenme: {new Date(w.resetsAt).toLocaleString('tr-TR')}
                </p>
              )}
            </div>
          ))}
          {data.balances.map((b, index) => (
            <div key={index} className="flex justify-between gap-2 text-xs">
              <span>{b.label}</span>
              <strong>
                {format(b.value)} {b.unit}
              </strong>
            </div>
          ))}
          {data.message && <p className="text-muted-foreground text-xs">{data.message}</p>}
        </>
      )}
      {data && (
        <div className="text-muted-foreground border-t border-border pt-2 text-[11px]">
          Kaynak: {data.source}
          <br />
          Son sorgu: {new Date(data.checkedAt).toLocaleString('tr-TR')}
          {query.isError && ' · Güncel veri alınamadı'}
        </div>
      )}
    </div>
  );
}
export function AccountUsagePanel({ host }: { host: HostRef }) {
  return (
    <section className="space-y-3" aria-label="Hesap kredileri ve kullanım limitleri">
      <div>
        <h3 className="font-semibold">Hesap kredileri ve kullanım limitleri</h3>
        <p className="text-muted-foreground text-xs">
          {host.type === 'remote' ? 'Seçili uzak makinenin' : 'Bu Mac’in'} ajan oturumlarından
          alınır. Yüzdeler kalan abonelik kotasını, bakiyeler sağlayıcının bildirdiği birimi
          gösterir. İki dakikada bir yenilenir.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {providers.map(([id, name]) => (
          <UsageCard key={`${host.type}-${host.id}-${id}`} host={host} id={id} name={name} />
        ))}
      </div>
    </section>
  );
}
