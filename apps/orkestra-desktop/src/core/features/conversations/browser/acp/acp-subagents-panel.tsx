import type { AgentActivityEntry, AgentState } from '@orkestra/core/runtimes/acp/api/client';
import { Markdown } from '@orkestra/ui/react/components';
import { prefersReducedMotion, subscribeAnimationTicker } from '@orkestra/ui/react/primitives';
import {
  AlertCircle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Layers,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Sparkles,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatElapsed(startedAt: number, completedAt: number | undefined, now: number): string {
  const end = completedAt ?? now;
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) {
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
  return `${secs}s`;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function shortAgentId(agentId: string): string {
  if (!agentId) return '';
  return agentId.length > 10 ? agentId.slice(0, 8) : agentId;
}

function formatEffortLabel(effort?: string): string | null {
  if (!effort) return null;
  const e = effort.trim().toLowerCase();
  if (e === 'low') return 'Düşük';
  if (e === 'medium') return 'Orta';
  if (e === 'high') return 'Yüksek';
  if (e === 'xhigh') return 'Çok Yüksek';
  if (e === 'max') return 'Maks';
  return effort;
}

function providerMeta(provider?: string): {
  label: string;
  badgeClass: string;
  accentDot: string;
} {
  const p = (provider || '').toLowerCase();
  if (p === 'codex') {
    return {
      label: 'Codex',
      badgeClass: 'bg-emerald-500/12 text-emerald-300 ring-1 ring-inset ring-emerald-500/25',
      accentDot: 'bg-emerald-400',
    };
  }
  if (p === 'claude') {
    return {
      label: 'Claude',
      badgeClass: 'bg-amber-500/12 text-amber-300 ring-1 ring-inset ring-amber-500/25',
      accentDot: 'bg-amber-400',
    };
  }
  if (p === 'kimi') {
    return {
      label: 'Kimi',
      badgeClass: 'bg-cyan-500/12 text-cyan-300 ring-1 ring-inset ring-cyan-500/25',
      accentDot: 'bg-cyan-400',
    };
  }
  if (p === 'grok') {
    return {
      label: 'Grok',
      badgeClass: 'bg-zinc-500/15 text-zinc-200 ring-1 ring-inset ring-zinc-400/30',
      accentDot: 'bg-zinc-300',
    };
  }
  if (p === 'gemini') {
    return {
      label: 'Gemini',
      badgeClass: 'bg-blue-500/12 text-blue-300 ring-1 ring-inset ring-blue-500/25',
      accentDot: 'bg-blue-400',
    };
  }
  if (p === 'antigravity') {
    return {
      label: 'Antigravity',
      badgeClass: 'bg-indigo-500/12 text-indigo-300 ring-1 ring-inset ring-indigo-500/25',
      accentDot: 'bg-indigo-400',
    };
  }
  return {
    label: provider || 'Ajan',
    badgeClass: 'bg-foreground/[0.06] text-foreground-muted ring-1 ring-inset ring-border/60',
    accentDot: 'bg-sky-400',
  };
}

function OrbitalSpinner({ active, failed }: { active: boolean; failed?: boolean }) {
  if (failed) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-rose-400">
        <AlertCircle className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (!active) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-emerald-400/90">
        <CheckCircle2 className="h-3.5 w-3.5" />
      </span>
    );
  }
  return <ActiveOrbitalSpinner />;
}

/**
 * Çalışan ajan göstergeleri CSS animasyonu kullanmaz: 12 ajan aynı anda çalışırken kart başına
 * altı sürekli animasyon (halka, dönen yay, üç çubuk, parlayan çizgi) pencereyi bir çekirdeğin
 * üzerinde meşgul ediyordu. Dönüş ve çubuklar ortak düşük frekanslı zamanlayıcıdan (saniyede 8
 * adım) sürülür; React yeniden çizilmez, yalnızca öğenin stili değişir.
 */
function useTickerStyle<T extends HTMLElement>(apply: (element: T, tick: number) => void) {
  const ref = useRef<T>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (prefersReducedMotion()) return;
    return subscribeAnimationTicker((tick) => {
      if (ref.current) applyRef.current(ref.current, tick);
    });
  }, []);
  return ref;
}

const SPINNER_STEPS = 8;

function ActiveOrbitalSpinner() {
  const arcRef = useTickerStyle<HTMLSpanElement>((element, tick) => {
    element.style.transform = `rotate(${(tick % SPINNER_STEPS) * (360 / SPINNER_STEPS)}deg)`;
  });
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-full border border-sky-400/25" />
      <span
        ref={arcRef}
        className="absolute h-3.5 w-3.5 rounded-full border-[1.5px] border-sky-400/80 border-t-transparent border-r-transparent"
      />
      <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.85)]" />
    </span>
  );
}

/** Çubukların bir çevrimdeki yükseklik ölçeği (8 adım); her çubuk iki adım geriden gelir. */
const BAR_WAVE = [0.4, 0.58, 0.82, 1, 0.82, 0.58, 0.4, 0.4] as const;
const BAR_HEIGHTS_PX = [6, 10, 7] as const;

export function liveBarScale(tick: number, barIndex: number): number {
  const length = BAR_WAVE.length;
  return BAR_WAVE[(((tick - barIndex * 2) % length) + length) % length] ?? 0.4;
}

function LiveBars() {
  const ref = useTickerStyle<HTMLSpanElement>((element, tick) => {
    for (let index = 0; index < element.children.length; index += 1) {
      const bar = element.children[index] as HTMLElement;
      const scale = liveBarScale(tick, index);
      bar.style.transform = `scaleY(${scale})`;
      bar.style.opacity = String(0.45 + (scale - 0.4) * (0.55 / 0.6));
    }
  });
  return (
    <span ref={ref} className="inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
      {BAR_HEIGHTS_PX.map((height) => (
        <span
          key={height}
          className="w-[2px] origin-bottom rounded-full bg-sky-400/85"
          style={{ height: `${height}px` }}
        />
      ))}
    </span>
  );
}

function ActivityGlyph({ entry }: { entry: AgentActivityEntry }) {
  if (entry.kind === 'error') {
    return <AlertCircle className="h-3 w-3 shrink-0 text-rose-400" />;
  }
  if (entry.kind === 'thinking') {
    return <Brain className="h-3 w-3 shrink-0 text-violet-400/90" />;
  }
  if (entry.kind === 'message') {
    return <MessageSquare className="h-3 w-3 shrink-0 text-emerald-400/90" />;
  }
  if (entry.kind === 'tool') {
    return entry.title.toLowerCase().includes('komut') ? (
      <Terminal className="h-3 w-3 shrink-0 text-sky-400/90" />
    ) : (
      <Wrench className="h-3 w-3 shrink-0 text-sky-400/90" />
    );
  }
  return <Sparkles className="h-3 w-3 shrink-0 text-amber-400/90" />;
}

function SubagentCard({
  agent,
  expanded,
  onToggle,
  now,
  onCancelSubagent,
}: {
  agent: AgentState;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const openLink = useMarkdownLinkOpener();
  const isRunning = agent.status === 'running';
  const isFailed = agent.status === 'failed';
  const isValidUuid = UUID_RE.test(agent.agentId);
  const canCancel = isRunning && Boolean(onCancelSubagent) && isValidUuid;
  const activities = agent.activities ?? [];
  const lastActivity = activities.length > 0 ? activities[activities.length - 1] : undefined;
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const prov = providerMeta(agent.provider);
  const effortLabel = formatEffortLabel(agent.effort);

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const handleStop = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!canCancel || stopping || !onCancelSubagent) return;
    setStopping(true);
    try {
      await onCancelSubagent(agent.agentId);
    } finally {
      setStopping(false);
    }
  };

  const handleCopyPrompt = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!agent.prompt) return;
    void navigator.clipboard?.writeText(agent.prompt).then(() => {
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1500);
    });
  };

  const handleCopyResponse = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!agent.summary) return;
    void navigator.clipboard?.writeText(agent.summary).then(() => {
      setCopiedResponse(true);
      window.setTimeout(() => setCopiedResponse(false), 1500);
    });
  };

  return (
    <div
      className={`group relative overflow-hidden rounded-lg border transition-all duration-200 ${
        isRunning
          ? 'border-sky-500/30 bg-sky-500/[0.03]'
          : isFailed
            ? 'border-rose-500/30 bg-rose-500/[0.025]'
            : expanded
              ? 'border-border/80 bg-foreground/[0.03]'
              : 'border-border/50 bg-foreground/[0.015] hover:border-border/80 hover:bg-foreground/[0.028]'
      }`}
    >
      {isRunning && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[1.5px]"
            style={{
              // Sabit vurgu çizgisi: kayan degrade her karede boyama gerektiriyordu.
              background:
                'linear-gradient(90deg, transparent 0%, rgba(56,189,248,0.85) 50%, transparent 100%)',
            }}
          />
          <div className="pointer-events-none absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-gradient-to-b from-sky-400/80 via-indigo-400/70 to-sky-400/20" />
        </>
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full cursor-pointer flex-col gap-2 px-3 py-2.5 text-left transition-colors outline-none focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:ring-inset"
        aria-expanded={expanded}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <OrbitalSpinner active={isRunning} failed={isFailed} />
            <span className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-foreground">
              {agent.name}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-foreground-muted">
            {isRunning && (
              <button
                type="button"
                onClick={(event) => void handleStop(event)}
                disabled={!canCancel || stopping}
                title={
                  !onCancelSubagent
                    ? 'Bu görünümde durdurma desteklenmiyor'
                    : !isValidUuid
                      ? 'Bu alt ajan tekil olarak durdurulamıyor'
                      : 'Alt ajanı durdur'
                }
                aria-label="Durdur"
                className="inline-flex cursor-pointer items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 transition-colors outline-none hover:border-rose-500/50 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {stopping ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Square className="h-2.5 w-2.5 fill-current" />
                )}
                <span>{stopping ? 'Durduruluyor' : 'Durdur'}</span>
              </button>
            )}
            {isRunning && <LiveBars />}
            <span className="font-mono tabular-nums opacity-80">{elapsed}</span>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 opacity-60 transition-transform" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 opacity-60 transition-transform group-hover:translate-x-0.5" />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {agent.provider && (
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-[1px] text-[10px] font-medium ${prov.badgeClass}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${prov.accentDot}`} />
              {prov.label}
            </span>
          )}

          {agent.model && (
            <span className="inline-flex items-center gap-1 rounded bg-foreground/[0.06] px-1.5 py-[1px] font-mono text-[10px] text-foreground/85">
              <Cpu className="h-2.5 w-2.5 opacity-60" />
              {agent.model}
            </span>
          )}

          {effortLabel && (
            <span className="rounded bg-foreground/[0.05] px-1.5 py-[1px] text-[10px] text-foreground-muted">
              {effortLabel} efor
            </span>
          )}

          {agent.role && !agent.model && (
            <span className="rounded bg-foreground/[0.05] px-1.5 py-[1px] font-mono text-[10px] text-foreground-muted">
              {agent.role}
            </span>
          )}

          <span className="ml-auto font-mono text-[10px] text-foreground-muted/60">
            {shortAgentId(agent.agentId)}
          </span>
        </div>

        {!expanded && (
          <div className="space-y-1 pl-6">
            {agent.prompt && (
              <p className="line-clamp-2 text-[11.5px] leading-[1.45] text-foreground/75">
                {agent.prompt}
              </p>
            )}
            <div className="flex items-center gap-1.5 text-[10.5px] text-foreground-muted">
              <span
                className={
                  isRunning ? 'text-sky-400' : isFailed ? 'text-rose-400' : 'text-emerald-400/90'
                }
              >
                {isRunning ? 'Çalışıyor' : isFailed ? 'Hata' : 'Tamamlandı'}
              </span>
              <span className="opacity-40">·</span>
              <span className="truncate opacity-80">
                {agent.summary
                  ? agent.summary
                  : lastActivity
                    ? lastActivity.detail
                      ? `${lastActivity.title}: ${lastActivity.detail}`
                      : lastActivity.title
                    : isRunning
                      ? 'Adımlar bekleniyor…'
                      : 'Yanıt için tıklayın'}
              </span>
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/50 px-3 py-3 text-xs">
          {agent.prompt && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.04em] text-foreground-muted uppercase">
                  <MessageSquare className="h-3 w-3 opacity-75" />
                  Gönderilen Talimat
                </span>
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-foreground-muted transition-colors outline-none hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span className="text-emerald-400">Kopyalandı</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Kopyala</span>
                    </>
                  )}
                </button>
              </div>
              <div className="max-h-44 overflow-y-auto rounded-lg bg-foreground/[0.045] px-3 py-2 text-[12px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/90 ring-1 ring-border/50 select-text ring-inset">
                {agent.prompt}
              </div>
            </div>
          )}

          {(isRunning || activities.length > 0) && (
            <div>
              {isRunning ? (
                <>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-medium tracking-[0.06em] text-foreground-muted/80 uppercase">
                      Aktivite Akışı
                      {activities.length > 0 && (
                        <span className="ml-1.5 font-mono text-foreground-muted/60">
                          {activities.length}
                        </span>
                      )}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-sky-400">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                      Canlı
                    </span>
                  </div>
                  {activities.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-md bg-background/40 px-2.5 py-2 text-[11px] text-foreground-muted">
                      <LiveBars />
                      <span>Alt ajan başlatılıyor, adımlar bekleniyor…</span>
                    </div>
                  ) : (
                    <div className="relative max-h-48 space-y-2 overflow-y-auto pr-1 pl-3 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px before:bg-border/60">
                      {activities.map((entry) => (
                        <div key={entry.id} className="relative pl-3">
                          <span className="absolute top-1 -left-[7px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--em-surface)">
                            <ActivityGlyph entry={entry} />
                          </span>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[11.5px] font-medium text-foreground/90">
                              {entry.title}
                            </span>
                            {entry.timestamp && (
                              <span className="shrink-0 font-mono text-[9.5px] text-foreground-muted/60 tabular-nums">
                                {formatTime(entry.timestamp)}
                              </span>
                            )}
                          </div>
                          {entry.detail && (
                            <p className="mt-0.5 text-[11px] leading-[1.45] break-words whitespace-pre-wrap text-foreground-muted">
                              {entry.detail}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActivitiesOpen((prev) => !prev);
                    }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-md bg-foreground/[0.03] px-2.5 py-1.5 text-[11px] text-foreground-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {activitiesOpen ? (
                        <ChevronDown className="h-3 w-3 opacity-75" />
                      ) : (
                        <ChevronRight className="h-3 w-3 opacity-75" />
                      )}
                      <span>Ara adımlar ({activities.length})</span>
                    </span>
                  </button>
                  {activitiesOpen && (
                    <div className="relative mt-2 max-h-48 space-y-2 overflow-y-auto pr-1 pl-3 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px before:bg-border/60">
                      {activities.map((entry) => (
                        <div key={entry.id} className="relative pl-3">
                          <span className="absolute top-1 -left-[7px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--em-surface)">
                            <ActivityGlyph entry={entry} />
                          </span>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[11.5px] font-medium text-foreground/90">
                              {entry.title}
                            </span>
                            {entry.timestamp && (
                              <span className="shrink-0 font-mono text-[9.5px] text-foreground-muted/60 tabular-nums">
                                {formatTime(entry.timestamp)}
                              </span>
                            )}
                          </div>
                          {entry.detail && (
                            <p className="mt-0.5 text-[11px] leading-[1.45] break-words whitespace-pre-wrap text-foreground-muted">
                              {entry.detail}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.04em] uppercase">
                <span
                  className={`h-2 w-2 rounded-full ${
                    isFailed ? 'bg-rose-400' : isRunning ? 'bg-sky-400' : prov.accentDot
                  }`}
                />
                <span
                  className={
                    isFailed ? 'text-rose-400' : isRunning ? 'text-sky-400' : 'text-emerald-400'
                  }
                >
                  {isFailed ? 'Hata Detayı' : 'Alt Ajan Yanıtı'}
                </span>
                {agent.model && (
                  <span className="font-mono text-[10px] font-normal tracking-normal text-foreground-muted lowercase">
                    · {agent.model}
                  </span>
                )}
              </span>
              {agent.summary && (
                <button
                  type="button"
                  onClick={handleCopyResponse}
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-foreground-muted transition-colors outline-none hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none"
                >
                  {copiedResponse ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span className="text-emerald-400">Kopyalandı</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Kopyala</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {isRunning && !agent.summary ? (
              <div className="flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.04] px-3 py-2.5 text-[11.5px] text-foreground-muted">
                <LiveBars />
                <span>Alt ajan yanıt hazırlıyor…</span>
              </div>
            ) : agent.summary ? (
              <div
                className={`max-h-72 overflow-y-auto rounded-lg border px-3 py-2.5 text-[12px] leading-[1.6] break-words text-foreground/95 select-text [&_*:last-child]:mb-0 ${
                  isFailed
                    ? 'border-rose-500/30 bg-rose-500/[0.055]'
                    : 'border-emerald-500/25 bg-emerald-500/[0.045]'
                }`}
              >
                <Markdown content={agent.summary} variant="compact" onOpenLink={openLink} />
              </div>
            ) : (
              <div className="rounded-lg border border-border/50 bg-foreground/[0.02] px-3 py-2 text-[11.5px] text-foreground-muted">
                Alt ajan metin yanıtı döndürmedi.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AcpSubagentsTogglePill({
  agents,
  onOpen,
}: {
  agents: readonly AgentState[];
  onOpen: () => void;
}) {
  const runningCount = agents.filter((a) => a.status === 'running').length;
  if (agents.length === 0) return null;
  const label =
    runningCount > 0 ? `${runningCount} alt ajan çalışıyor` : `${agents.length} alt ajan`;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-medium shadow-md backdrop-blur-md transition-all outline-none hover:border-border focus:outline-none ${
        runningCount > 0
          ? 'border-sky-500/35 bg-background/90 text-foreground'
          : 'border-border/70 bg-background/85 text-foreground-muted hover:text-foreground'
      }`}
    >
      <OrbitalSpinner active={runningCount > 0} />
      {/* Dar sohbet başlığında (container query) yalnız sayaç kalır. */}
      <span className="@max-[28rem]:hidden">{label}</span>
      <span className="hidden tabular-nums @max-[28rem]:inline">
        {runningCount > 0 ? runningCount : agents.length}
      </span>
    </button>
  );
}

export function AcpSubagentsPanel({
  agents,
  onClose,
  onCancelSubagent,
}: {
  agents: readonly AgentState[];
  onClose: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  const runningCount = useMemo(
    () => agents.filter((agent) => agent.status === 'running').length,
    [agents]
  );

  useEffect(() => {
    if (runningCount === 0) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [runningCount]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return b.startedAt - a.startedAt;
    });
  }, [agents]);

  // Çalışma sürerken biten ajanlar listeyi kalabalıklaştırmasın: tamamlananlar katlanmış bir
  // bölümde durur. Hiç çalışan yokken panel elle açıldıysa doğrudan tamamlananlar gösterilir.
  const [showCompleted, setShowCompleted] = useState(false);
  const runningAgents = sortedAgents.filter((agent) => agent.status === 'running');
  const finishedAgents = sortedAgents.filter((agent) => agent.status !== 'running');
  const completedVisible = runningAgents.length === 0 || showCompleted;

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderCard = (agent: AgentState) => {
    const key = agent.toolCallId || agent.agentId;
    return (
      <SubagentCard
        key={key}
        agent={agent}
        expanded={expandedIds.has(key)}
        onToggle={() => toggleExpanded(key)}
        now={now}
        onCancelSubagent={onCancelSubagent}
      />
    );
  };

  return (
    <aside className="relative flex h-full w-[340px] max-w-[45%] shrink-0 flex-col border-l border-border/60 bg-(--em-surface)">
      <header className="flex items-center justify-between border-b border-border/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-foreground/[0.05] text-foreground-muted">
            {runningCount > 0 ? <OrbitalSpinner active /> : <Layers className="h-3.5 w-3.5" />}
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <h2 className="text-[12.5px] font-semibold tracking-[-0.01em] text-foreground">
                Alt Ajanlar
              </h2>
              <span
                className={`rounded-full px-1.5 py-[1px] font-mono text-[10px] font-medium ${
                  runningCount > 0
                    ? 'bg-sky-500/15 text-sky-400'
                    : 'bg-foreground/[0.06] text-foreground-muted'
                }`}
              >
                {runningCount > 0 ? `${runningCount}/${agents.length}` : agents.length}
              </span>
            </div>
            <p className="mt-0.5 text-[10.5px] text-foreground-muted/80">
              {runningCount > 0 ? 'Canlı yürütme takibi' : 'Tamamlanan çalıştırmalar'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Paneli gizle"
          aria-label="Alt ajan panelini gizle"
          className="rounded-md p-1 text-foreground-muted transition-colors outline-none hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
        {runningAgents.map((agent) => renderCard(agent))}
        {runningAgents.length > 0 && finishedAgents.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowCompleted((value) => !value)}
            aria-expanded={showCompleted}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] text-foreground-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <span>Tamamlananlar ({finishedAgents.length})</span>
            <span aria-hidden="true">{showCompleted ? '−' : '+'}</span>
          </button>
        ) : null}
        {completedVisible ? finishedAgents.map((agent) => renderCard(agent)) : null}
      </div>
    </aside>
  );
}
