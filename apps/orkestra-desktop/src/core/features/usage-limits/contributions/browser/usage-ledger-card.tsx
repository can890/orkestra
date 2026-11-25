import { Button } from '@orkestra/ui/react/primitives';
import { BarChart3, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getUsageLimitsClient } from '@core/features/usage-limits/api/browser/client';
import type { UsageLedgerSummary } from '@core/features/usage-limits/api/usage-limits';

const RANGE_OPTIONS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 1, label: 'Bugün' },
  { days: 7, label: '7 Gün' },
  { days: 30, label: '30 Gün' },
];

const PROVIDER_DISPLAY: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  glm: 'GLM',
  grok: 'Grok',
  gemini: 'Gemini',
};

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function UsageLedgerCard() {
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [summary, setSummary] = useState<UsageLedgerSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmClear, setConfirmClear] = useState<boolean>(false);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const client = await getUsageLimitsClient();
      const next = await client.getLedgerSummary({ rangeDays: days });
      setSummary(next);
    } catch {
      // İlk yükleme veya kapanış sırasında sessizce boş bırak.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(rangeDays);
  }, [load, rangeDays]);

  const handleClear = async () => {
    try {
      const client = await getUsageLimitsClient();
      await client.clearLedger({});
      setConfirmClear(false);
      await load(rangeDays);
    } catch {
      setConfirmClear(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="text-muted-foreground size-4" />
          <div>
            <h4 className="text-sm font-semibold">Kullanım ve Maliyet Defteri</h4>
            <p className="text-muted-foreground text-xs">
              Bu Mac’teki ajan turları, bağlam token artışı ve bildirilen maliyetlerin yerel özeti.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.days}
              type="button"
              size="xs"
              variant={rangeDays === opt.days ? 'secondary' : 'ghost'}
              onClick={() => setRangeDays(opt.days)}
            >
              {opt.label}
            </Button>
          ))}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={() => void load(rangeDays)}
            title="Defteri yenile"
          >
            <RotateCcw className="size-3.5" />
          </Button>
          {confirmClear ? (
            <div className="flex items-center gap-1">
              <Button type="button" size="xs" variant="destructive" onClick={handleClear}>
                Sıfırla
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setConfirmClear(false)}
              >
                İptal
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!summary || summary.totals.turns === 0}
              onClick={() => setConfirmClear(true)}
              title="Defter geçmişini temizle"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-surface-subtle/40 rounded-md border border-border/60 px-3 py-2">
          <div className="text-muted-foreground text-[11px]">Toplam Tur</div>
          <div className="font-mono text-sm font-semibold">
            {summary ? summary.totals.turns.toLocaleString('tr-TR') : '—'}
          </div>
        </div>
        <div className="bg-surface-subtle/40 rounded-md border border-border/60 px-3 py-2">
          <div className="text-muted-foreground text-[11px]">Token Artışı</div>
          <div className="font-mono text-sm font-semibold">
            {summary ? formatCompactTokens(summary.totals.tokens) : '—'}
          </div>
        </div>
        <div className="bg-surface-subtle/40 rounded-md border border-border/60 px-3 py-2">
          <div className="text-muted-foreground text-[11px]">Tahmini Maliyet</div>
          <div className="font-mono text-sm font-semibold">
            {summary ? formatUsd(summary.totals.costUsd) : '—'}
          </div>
        </div>
      </div>

      {summary && summary.byProvider.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-subtle/60 text-[11px] text-foreground-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Ajan</th>
                <th className="px-3 py-1.5 text-right font-medium">Tur</th>
                <th className="px-3 py-1.5 text-right font-medium">Token</th>
                <th className="px-3 py-1.5 text-right font-medium">Maliyet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {summary.byProvider.map((row) => (
                <tr key={row.providerId}>
                  <td className="px-3 py-1.5 font-medium">
                    {PROVIDER_DISPLAY[row.providerId] ?? row.providerId}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {row.turns.toLocaleString('tr-TR')}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {formatCompactTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {loading
            ? 'Kullanım kayıtları yükleniyor…'
            : 'Seçilen aralıkta henüz kaydedilmiş kullanım verisi yok.'}
        </p>
      )}
    </div>
  );
}
