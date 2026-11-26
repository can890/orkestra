import { Tooltip } from '@orkestra/ui/react/primitives';
import { Clock, Coins, Cpu } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { getUsageLimitsClient } from '@core/features/usage-limits/api/browser/client';
import type { ConversationUsageStats } from '@core/features/usage-limits/api/usage-limits';
import type { AcpChatStore } from './acp-chat-store';
import {
  computeTranscriptStats,
  formatWorkDuration,
  resolveSessionWorkDisplay,
} from './chat-session-metrics-model';

const PRICE_OVERRIDES_KEY = 'sovra:usage:priceOverridesPer1M:v1';

function readPriceOverridePer1M(providerId: string): number | null {
  if (!providerId) return null;
  try {
    const raw = window.localStorage.getItem(PRICE_OVERRIDES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed?.[providerId];
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : null;
  } catch {
    return null;
  }
}

type ModelRates = { input: number; cachedInput: number; output: number };

/**
 * Sağlayıcı maliyet ve günlük verisi vermiyorsa kullanılan ayrıştırılmış 1M token USD oranları.
 * Not: `gemini` içinde `mini` geçtiği için `gemini` her zaman `mini`'den önce kontrol edilir.
 */
function fallbackRatesPer1M(providerId: string, model?: string | null): ModelRates {
  const m = (model ?? '').toLowerCase();
  const p = providerId.toLowerCase();

  if (m.includes('opus') || m.includes('mythos')) {
    return { input: 15, cachedInput: 1.5, output: 75 };
  }
  if (m.includes('sonnet')) {
    return { input: 3, cachedInput: 0.3, output: 15 };
  }
  if (m.includes('haiku')) {
    return { input: 0.8, cachedInput: 0.08, output: 4 };
  }
  if (m.includes('gemini') || p === 'gemini' || p === 'antigravity') {
    if (m.includes('flash') || m.includes('lite')) {
      return { input: 0.3, cachedInput: 0.075, output: 2.5 };
    }
    if (m.includes('carbon') || m.includes('ultra') || m.includes('orchestrator')) {
      return { input: 3.5, cachedInput: 0.35, output: 15 };
    }
    return { input: 2.5, cachedInput: 0.25, output: 12 };
  }
  if (m.includes('astra') || m.includes('gpt-5-pro') || m.includes('o1-pro') || m.includes('o3-pro')) {
    return { input: 5, cachedInput: 0.5, output: 20 };
  }
  if (/\bmini\b|\bnano\b|gpt-.*mini|o\d-mini/.test(m)) {
    return { input: 0.4, cachedInput: 0.1, output: 1.6 };
  }
  if (
    m.includes('gpt-6') ||
    m.includes('gpt-5') ||
    m.includes('codex') ||
    m.includes('o1') ||
    m.includes('o3') ||
    p === 'codex'
  ) {
    return { input: 2.5, cachedInput: 0.25, output: 15 };
  }
  if (p === 'claude') {
    return { input: 5, cachedInput: 0.5, output: 25 };
  }
  if (p === 'grok' || m.includes('grok')) {
    return { input: 3, cachedInput: 0.75, output: 15 };
  }
  if (p === 'kimi' || p === 'glm' || m.includes('kimi') || m.includes('glm')) {
    return { input: 0.6, cachedInput: 0.15, output: 2.5 };
  }
  return { input: 2.5, cachedInput: 0.25, output: 12 };
}

/**
 * Yalnızca anlık bağlam penceresi biliniyorsa (örn. uzak SSH oturumunda log okunamadığında)
 * tipik çok-adımlı ajan konuşması için muhafazakâr maliyet tahmini hesaplar.
 */
function estimateFallbackCostUsd(
  tokens: number,
  providerId: string,
  model?: string | null
): number {
  const r = fallbackRatesPer1M(providerId, model);
  // Tipik bir ajan bağlamında %65 önbellekli girdi, %25 taze girdi, %10 çıktı varsayımı.
  const blended = r.cachedInput * 0.65 + r.input * 0.25 + r.output * 0.1;
  return (tokens / 1_000_000) * blended;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

function formatTimeAgo(timestampMs: number, now: number): string {
  const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSec < 45) return 'az önce';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}dk önce`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return remMins > 0 && hours < 6 ? `${hours}sa ${remMins}dk önce` : `${hours}sa önce`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}g önce`;
  const months = Math.floor(days / 30);
  return `${months}ay önce`;
}

/**
 * Sohbet üst şeridinin sol tarafında çalışma süresi, ne kadar önce yapıldığı,
 * kümülatif token kullanımı ve doğru USD maliyetini sade tek satır halinde gösterir.
 */
export const ChatSessionMetricsStrip = observer(function ChatSessionMetricsStrip({
  store,
  providerId,
}: {
  store: AcpChatStore;
  providerId?: string | null;
}) {
  const resolvedProviderId = providerId ?? '';
  const isWorking = store.affordances.isWorking;
  const conversationId = store.conversationId;
  const [now, setNow] = useState(() => Date.now());
  const [diskStats, setDiskStats] = useState<ConversationUsageStats | null>(null);
  const wasWorkingRef = useRef(isWorking);
  const workStartedAtRef = useRef<{ conversationId: string; at: number } | null>(
    isWorking ? { conversationId, at: Date.now() } : null
  );

  // Sohbet veya çalışma durumu değiştiğinde yerel aktif tur başlangıç damgasını güncelle.
  if (isWorking) {
    if (!workStartedAtRef.current || workStartedAtRef.current.conversationId !== conversationId) {
      workStartedAtRef.current = { conversationId, at: Date.now() };
    }
  } else if (workStartedAtRef.current !== null) {
    workStartedAtRef.current = null;
  }

  useEffect(() => {
    setNow(Date.now());
    const intervalMs = isWorking ? 1_000 : 30_000;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [isWorking, conversationId]);

  useEffect(() => {
    let cancelled = false;
    setDiskStats(null);
    const fetchStats = async () => {
      if (!conversationId) return;
      try {
        const client = await getUsageLimitsClient();
        const result = await client.getConversationStats({ conversationId });
        if (!cancelled) setDiskStats(result);
      } catch {
        // Sessizce mevcut canlı verilerle devam et.
      }
    };

    void fetchStats();
    // Çalışırken periyodik olarak gerçek günlük istatistiğini tazele.
    if (!isWorking) {
      if (wasWorkingRef.current) {
        // Tur yeni bitti; sağlayıcının cost-state/JSONL yazması için kısa bir ek okuma yap.
        const t = window.setTimeout(() => void fetchStats(), 1_200);
        wasWorkingRef.current = false;
        return () => {
          cancelled = true;
          window.clearTimeout(t);
        };
      }
      wasWorkingRef.current = false;
      return () => {
        cancelled = true;
      };
    }

    wasWorkingRef.current = true;
    const poll = window.setInterval(() => void fetchStats(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [conversationId, isWorking]);

  const transcriptState = store.chatState.transcript.state;
  const transcriptStats = computeTranscriptStats(
    transcriptState.displayTurns,
    transcriptState.activeTurnSnapshot ?? null,
    isWorking,
    now
  );
  const usage = store.usage;
  const effectiveModel = store.model ?? diskStats?.model ?? null;
  const effectiveProvider = resolvedProviderId || diskStats?.providerId || '';

  // 1) Token kaynağı önceliği: Gerçek kümülatif log > Defter > Anlık bağlam > Metin tahmini.
  const hasRealLogTokens = diskStats !== null && diskStats.source === 'provider-log' && diskStats.totalTokens > 0;
  const hasLedgerTokens = diskStats !== null && diskStats.source === 'ledger' && diskStats.totalTokens > 0;
  const contextUsed = usage && usage.contextUsed > 0 ? usage.contextUsed : null;
  const contextSize = usage && usage.contextSize > 0 ? usage.contextSize : null;

  const displayTokens = hasRealLogTokens
    ? diskStats.totalTokens
    : hasLedgerTokens
      ? Math.max(diskStats.totalTokens, contextUsed ?? 0)
      : contextUsed ?? (transcriptStats.estimatedTokens > 0 ? transcriptStats.estimatedTokens : null);
  const isContextOnly = !hasRealLogTokens && !hasLedgerTokens && contextUsed !== null;
  const tokensIsEstimate = !hasRealLogTokens && !hasLedgerTokens && contextUsed === null && displayTokens !== null;

  // 2) USD maliyet önceliği:
  //    a) Kullanıcının özel 1M token fiyat ayarı varsa onu uygula
  //    b) Sağlayıcının doğrudan bildirdiği kesin USD (canlı ACP cost veya Claude cost-state)
  //    c) Gerçek girdi/önbellek/çıktı kırılımından hesaplanan API eşdeğeri USD
  //    d) Son çare: bağlam/metin tahmini (düzeltilmiş model fiyat tablosuyla)
  const overridePer1M = effectiveProvider ? readPriceOverridePer1M(effectiveProvider) : null;
  const liveReportedCost =
    usage?.cost && typeof usage.cost.amount === 'number' && usage.cost.amount > 0
      ? usage.cost.amount
      : null;
  const logReportedCost =
    diskStats?.reportedCostUsd !== undefined && diskStats.reportedCostUsd > 0
      ? diskStats.reportedCostUsd
      : null;
  const exactReportedCost =
    liveReportedCost !== null || logReportedCost !== null
      ? Math.max(liveReportedCost ?? 0, logReportedCost ?? 0)
      : null;

  let computedCost: number | null = null;
  let costIsEstimate = false;
  if (overridePer1M !== null && displayTokens !== null) {
    computedCost = (displayTokens / 1_000_000) * overridePer1M;
    costIsEstimate = true;
  } else if (exactReportedCost !== null) {
    computedCost = exactReportedCost;
    costIsEstimate = false;
  } else if (diskStats?.estimatedCostUsd !== undefined && diskStats.estimatedCostUsd > 0) {
    computedCost = diskStats.estimatedCostUsd;
    costIsEstimate = true;
  } else if (displayTokens !== null) {
    // Bağlam penceresi tek başına tek çağrıdır; çok turlu oturumlarda gerçek harcamayı aşırı düşük göstermemek için tur sayısıyla ölçekle.
    const multiTurnScale =
      isContextOnly && transcriptStats.turnCount > 1
        ? Math.min(transcriptStats.turnCount, 12) * 0.65
        : 1;
    computedCost = estimateFallbackCostUsd(
      Math.round(displayTokens * multiTurnScale),
      effectiveProvider,
      effectiveModel
    );
    costIsEstimate = true;
  }

  // 3) Çalışma süresi:
  //    - Çalışırken ASLA geçmiş toplam süreye (totalWorkMs / diskStats) düşme; yalnız aktif turun
  //      kendi süresini (veya yerel çalışma başlangıcından itibaren geçen süreyi) göster.
  //    - Boştayken yalnızca tamamlanmış turların toplamını (veya günlük süresini) göster.
  const localActiveWorkMs =
    isWorking && workStartedAtRef.current
      ? Math.max(0, now - workStartedAtRef.current.at)
      : 0;
  const {
    activeWorkMs,
    totalWorkMs,
    hasWork,
    label: workLabel,
  } = resolveSessionWorkDisplay({
    isWorking,
    transcriptStats,
    localActiveWorkMs,
    diskWorkDurationMs: diskStats?.workDurationMs,
  });
  const hasAgo = !isWorking && transcriptStats.lastActivityAt !== null;

  if (!hasWork && !hasAgo && displayTokens === null && computedCost === null) return null;

  const exactLastTime = transcriptStats.lastActivityAt
    ? new Date(transcriptStats.lastActivityAt).toLocaleString('tr-TR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const contextPct =
    contextUsed !== null && contextSize !== null && contextSize > 0
      ? Math.min(100, Math.round((contextUsed / contextSize) * 100))
      : null;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-foreground-passive select-none">
            {hasWork && (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-foreground-muted">
                {isWorking ? (
                  <span className="size-1.5 rounded-full bg-sky-400 animate-pulse" />
                ) : (
                  <Clock className="size-3 opacity-70" />
                )}
                <span>{workLabel}</span>
              </span>
            )}

            {hasAgo && transcriptStats.lastActivityAt !== null && (
              <span className="shrink-0 truncate @max-[36rem]:hidden">
                {hasWork ? '· ' : ''}
                {formatTimeAgo(transcriptStats.lastActivityAt, now)}
              </span>
            )}

            {displayTokens !== null && (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-foreground-muted @max-[28rem]:hidden">
                {(hasWork || hasAgo) && <span className="opacity-45">·</span>}
                <Cpu className="size-3 opacity-65" />
                <span>
                  {tokensIsEstimate ? '~' : ''}
                  {formatCompactTokens(displayTokens)}
                  {isContextOnly ? ' bağlam' : ''}
                </span>
              </span>
            )}

            {computedCost !== null && (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-mono tabular-nums text-emerald-400/90 @max-[23rem]:hidden">
                <span className="mr-0.5 text-foreground-passive opacity-45">·</span>
                <Coins className="size-3 opacity-75" />
                <span>
                  {costIsEstimate ? '~' : ''}
                  {formatUsd(computedCost)}
                </span>
              </span>
            )}
          </div>
        }
      />
      <Tooltip.Content side="bottom" align="start" className="max-w-xs p-2.5 text-xs">
        <div className="space-y-1">
          {isWorking && activeWorkMs >= 1_000 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Aktif tur</span>
              <span className="font-mono text-foreground">{formatWorkDuration(activeWorkMs)}</span>
            </div>
          )}
          {totalWorkMs >= 1_000 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Toplam çalışma</span>
              <span className="font-mono text-foreground">{formatWorkDuration(totalWorkMs)}</span>
            </div>
          )}
          {exactLastTime && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Son işlem</span>
              <span className="font-mono text-foreground">{exactLastTime}</span>
            </div>
          )}
          {effectiveModel && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Model</span>
              <span className="font-mono text-foreground truncate max-w-[160px]">
                {effectiveModel}
              </span>
            </div>
          )}
          {hasRealLogTokens && diskStats && (
            <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-foreground-passive">Toplam token</span>
                <span className="font-mono text-foreground">
                  {diskStats.totalTokens.toLocaleString('tr-TR')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[11px]">
                <span className="text-foreground-passive">Girdi / Önbellek / Çıktı</span>
                <span className="font-mono text-foreground-muted">
                  {formatCompactTokens(diskStats.inputTokens)} /{' '}
                  {formatCompactTokens(diskStats.cachedInputTokens)} /{' '}
                  {formatCompactTokens(diskStats.outputTokens)}
                </span>
              </div>
            </>
          )}
          {!hasRealLogTokens && displayTokens !== null && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">
                {isContextOnly ? 'Anlık bağlam' : tokensIsEstimate ? 'Tahmini token' : 'Toplam token'}
              </span>
              <span className="font-mono text-foreground">
                {displayTokens.toLocaleString('tr-TR')}
              </span>
            </div>
          )}
          {contextUsed !== null && contextSize !== null && (
            <div className="flex items-center justify-between gap-4 text-[11px]">
              <span className="text-foreground-passive">Bağlam doluluğu</span>
              <span className="font-mono text-foreground-muted">
                {formatCompactTokens(contextUsed)} / {formatCompactTokens(contextSize)}
                {contextPct !== null ? ` (%${contextPct})` : ''}
              </span>
            </div>
          )}
          {computedCost !== null && (
            <div className="flex items-center justify-between gap-4 pt-0.5 border-t border-border/40">
              <span className="text-foreground-passive">
                {costIsEstimate ? 'API eşdeğeri maliyet' : 'Kesin maliyet'}
              </span>
              <span className="font-mono font-medium text-emerald-400">
                {costIsEstimate ? '~' : ''}
                {formatUsd(computedCost)}
              </span>
            </div>
          )}
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
});
