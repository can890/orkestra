import type { TranscriptTurn } from '@orkestra/chat-ui';
import { Tooltip } from '@orkestra/ui/react/primitives';
import { Clock, Coins, Cpu } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { AcpChatStore } from './acp-chat-store';
import { transcriptTurns } from './subagent-activity';

const PRICE_OVERRIDES_KEY = 'sovra:usage:priceOverridesPer1M:v1';

function readPriceOverridePer1M(providerId: string): number | null {
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

/** Sağlayıcı maliyet bildirmiyorsa model adına göre 1M token başına karma tahmini USD fiyatı. */
function defaultBlendedUsdPer1M(providerId: string, model?: string | null): number {
  const m = (model ?? '').toLowerCase();
  const p = providerId.toLowerCase();
  if (m.includes('opus')) return 15;
  if (m.includes('sonnet')) return 5;
  if (m.includes('haiku')) return 1.2;
  if (m.includes('o1') || m.includes('o3') || m.includes('gpt-5') || m.includes('6.2')) return 5;
  if (m.includes('codex') || p === 'codex') return 4;
  if (m.includes('flash') || m.includes('mini')) return 0.6;
  if (m.includes('gemini') || p === 'gemini' || p === 'antigravity') return 3.5;
  if (p === 'claude') return 6;
  if (p === 'kimi' || p === 'glm' || p === 'grok') return 1.5;
  return 3;
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

function formatWorkDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return mins > 0 ? `${hours}sa ${mins}dk` : `${hours}sa`;
  if (mins > 0) return secs > 0 ? `${mins}dk ${secs}sn` : `${mins}dk`;
  return `${secs}sn`;
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

function computeTranscriptStats(turns: readonly TranscriptTurn[], now: number): {
  totalWorkMs: number;
  activeWorkMs: number;
  lastActivityAt: number | null;
  estimatedTokens: number;
} {
  let totalWorkMs = 0;
  let activeWorkMs = 0;
  let lastActivityAt: number | null = null;
  let totalChars = 0;

  for (const turn of turns) {
    const started = typeof turn.startedAt === 'number' ? turn.startedAt : undefined;
    const completed = typeof turn.completedAt === 'number' ? turn.completedAt : undefined;

    if (started !== undefined) {
      if (completed !== undefined && completed >= started) {
        totalWorkMs += completed - started;
        if (lastActivityAt === null || completed > lastActivityAt) lastActivityAt = completed;
      } else if (!turn.outcome) {
        const elapsed = Math.max(0, now - started);
        activeWorkMs += elapsed;
        totalWorkMs += elapsed;
        if (lastActivityAt === null || started > lastActivityAt) lastActivityAt = started;
      } else if (lastActivityAt === null || started > lastActivityAt) {
        lastActivityAt = started;
      }
    }

    for (const item of turn.items) {
      if (item.kind === 'message') {
        totalChars += item.text.length;
        const created =
          'createdAt' in item && typeof item.createdAt === 'number' ? item.createdAt : undefined;
        if (created !== undefined && (lastActivityAt === null || created > lastActivityAt)) {
          lastActivityAt = created;
        }
      } else if (item.kind === 'thinking') {
        totalChars += item.text.length;
      } else if (item.kind === 'execute-tool-call' && item.outputText) {
        totalChars += Math.min(item.outputText.length, 4000);
      }
    }
  }

  return {
    totalWorkMs,
    activeWorkMs,
    lastActivityAt,
    estimatedTokens: totalChars > 0 ? Math.max(1, Math.round(totalChars / 4)) : 0,
  };
}

/**
 * Sohbet üst şeridinin sol tarafında çalışma süresi, ne kadar önce yapıldığı,
 * harcanan token sayısı ve dolar karşılığını sade tek satır halinde gösterir.
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Çalışırken saniye saniye, boştayken 30 saniyede bir "X dk önce" bilgisini tazele.
    const intervalMs = isWorking ? 1_000 : 30_000;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [isWorking]);

  const turns = transcriptTurns(store.chatState.transcript.state);
  const stats = computeTranscriptStats(turns, now);
  const usage = store.usage;

  const reportedTokens = usage && usage.contextUsed > 0 ? usage.contextUsed : null;
  const displayTokens = reportedTokens ?? (stats.estimatedTokens > 0 ? stats.estimatedTokens : null);
  const tokensIsEstimate = reportedTokens === null && displayTokens !== null;

  const reportedCost =
    usage?.cost && typeof usage.cost.amount === 'number' && usage.cost.amount > 0
      ? usage.cost.amount
      : null;
  const overridePer1M = resolvedProviderId ? readPriceOverridePer1M(resolvedProviderId) : null;
  const computedCost =
    reportedCost !== null
      ? reportedCost
      : displayTokens !== null
        ? (displayTokens / 1_000_000) *
          (overridePer1M ?? defaultBlendedUsdPer1M(resolvedProviderId, store.model))
        : null;
  const costIsEstimate = reportedCost === null && computedCost !== null;

  const workMs = isWorking && stats.activeWorkMs > 0 ? stats.activeWorkMs : stats.totalWorkMs;
  const hasWork = workMs >= 1_000;
  const hasAgo = !isWorking && stats.lastActivityAt !== null;

  if (!hasWork && !hasAgo && displayTokens === null) return null;

  const exactLastTime = stats.lastActivityAt
    ? new Date(stats.lastActivityAt).toLocaleString('tr-TR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-foreground-passive select-none">
            {hasWork && (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-foreground-muted">
                {isWorking ? (
                  <span className="size-1.5 rounded-full bg-sky-400 animate-pulse" />
                ) : (
                  <Clock className="size-3 opacity-70" />
                )}
                <span>
                  {formatWorkDuration(workMs)}
                  {isWorking ? ' çalışıyor' : ''}
                </span>
              </span>
            )}

            {hasAgo && stats.lastActivityAt !== null && (
              <span className="shrink-0 truncate @max-[32rem]:hidden">
                {hasWork ? '· ' : ''}
                {formatTimeAgo(stats.lastActivityAt, now)}
              </span>
            )}

            {displayTokens !== null && (
              <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-foreground-muted @max-[26rem]:hidden">
                {(hasWork || hasAgo) && <span className="opacity-45">·</span>}
                <Cpu className="size-3 opacity-65" />
                <span>
                  {tokensIsEstimate ? '~' : ''}
                  {formatCompactTokens(displayTokens)}
                </span>
              </span>
            )}

            {computedCost !== null && (
              <span className="inline-flex shrink-0 items-center gap-0.5 font-mono tabular-nums text-emerald-400/90 @max-[22rem]:hidden">
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
          {stats.totalWorkMs >= 1_000 && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Toplam çalışma</span>
              <span className="font-mono text-foreground">
                {formatWorkDuration(stats.totalWorkMs)}
              </span>
            </div>
          )}
          {exactLastTime && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">Son işlem</span>
              <span className="font-mono text-foreground">{exactLastTime}</span>
            </div>
          )}
          {displayTokens !== null && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">
                {tokensIsEstimate ? 'Tahmini token' : 'Bağlam tokenı'}
              </span>
              <span className="font-mono text-foreground">
                {displayTokens.toLocaleString('tr-TR')}
                {usage?.contextSize ? ` / ${formatCompactTokens(usage.contextSize)}` : ''}
              </span>
            </div>
          )}
          {computedCost !== null && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-foreground-passive">
                {costIsEstimate ? 'Tahmini maliyet' : 'Maliyet'}
              </span>
              <span className="font-mono text-emerald-400">
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
