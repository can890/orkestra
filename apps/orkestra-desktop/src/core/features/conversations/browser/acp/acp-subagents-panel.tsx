import type { AgentActivityEntry, AgentState } from '@orkestra/core/runtimes/acp/api/client';
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
  MessageSquare,
  PanelRightClose,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <span
        className="absolute inset-0 rounded-full border border-sky-400/25"
        style={{ animation: 'orkestra-pulse-ring 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
      />
      <span
        className="absolute h-3.5 w-3.5 rounded-full border-[1.5px] border-sky-400/80 border-t-transparent border-r-transparent"
        style={{ animation: 'orkestra-spin 0.9s linear infinite' }}
      />
      <span className="relative h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.85)]" />
    </span>
  );
}

function LiveBars() {
  return (
    <span className="inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
      <span
        className="w-[2px] rounded-full bg-sky-400/85"
        style={{ height: '6px', animation: 'orkestra-bar 1s ease-in-out infinite 0ms' }}
      />
      <span
        className="w-[2px] rounded-full bg-sky-400/85"
        style={{ height: '10px', animation: 'orkestra-bar 1s ease-in-out infinite 160ms' }}
      />
      <span
        className="w-[2px] rounded-full bg-sky-400/85"
        style={{ height: '7px', animation: 'orkestra-bar 1s ease-in-out infinite 320ms' }}
      />
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
}: {
  agent: AgentState;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}) {
  const [copied, setCopied] = useState(false);
  const isRunning = agent.status === 'running';
  const isFailed = agent.status === 'failed';
  const activities = agent.activities ?? [];
  const lastActivity = activities.length > 0 ? activities[activities.length - 1] : undefined;
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const prov = providerMeta(agent.provider);
  const effortLabel = formatEffortLabel(agent.effort);

  const handleCopyPrompt = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!agent.prompt) return;
    void navigator.clipboard?.writeText(agent.prompt).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
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
              background:
                'linear-gradient(90deg, transparent 0%, rgba(56,189,248,0.85) 50%, transparent 100%)',
              backgroundSize: '200% 100%',
              animation: 'orkestra-shimmer 1.9s linear infinite',
            }}
          />
          <div className="pointer-events-none absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-gradient-to-b from-sky-400/80 via-indigo-400/70 to-sky-400/20" />
        </>
      )}

      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col gap-2 px-3 py-2.5 text-left transition-colors outline-none focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:ring-inset"
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
                {lastActivity
                  ? lastActivity.detail
                    ? `${lastActivity.title}: ${lastActivity.detail}`
                    : lastActivity.title
                  : agent.summary
                    ? agent.summary
                    : isRunning
                      ? 'Adımlar bekleniyor…'
                      : 'Detay için tıklayın'}
              </span>
            </div>
          </div>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border/50 px-3 py-3 text-xs">
          {agent.prompt && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium tracking-[0.06em] text-foreground-muted/80 uppercase">
                  Prompt
                </span>
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-foreground-muted transition-colors outline-none hover:bg-foreground/[0.06] hover:text-foreground focus:outline-none"
                >
                  {copied ? (
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
              <div className="max-h-32 overflow-y-auto rounded-md bg-background/55 px-2.5 py-2 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85 ring-1 ring-border/40 ring-inset">
                {agent.prompt}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-medium tracking-[0.06em] text-foreground-muted/80 uppercase">
                Aktivite Akışı
                {activities.length > 0 && (
                  <span className="ml-1.5 font-mono text-foreground-muted/60">
                    {activities.length}
                  </span>
                )}
              </span>
              {isRunning && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-sky-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                  Canlı
                </span>
              )}
            </div>

            {activities.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md bg-background/40 px-2.5 py-2 text-[11px] text-foreground-muted">
                {isRunning ? (
                  <>
                    <LiveBars />
                    <span>Alt ajan başlatılıyor, adımlar bekleniyor…</span>
                  </>
                ) : (
                  <span>Kayıtlı ara adım bulunmuyor.</span>
                )}
              </div>
            ) : (
              <div className="relative max-h-56 space-y-2 overflow-y-auto pr-1 pl-3 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px before:bg-border/60">
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
          </div>

          {agent.summary && (
            <div
              className={`rounded-r-md border-l-2 px-2.5 py-2 ${
                isFailed
                  ? 'border-rose-500/70 bg-rose-500/[0.05]'
                  : 'border-emerald-500/70 bg-emerald-500/[0.045]'
              }`}
            >
              <div
                className={`mb-0.5 text-[10px] font-medium tracking-[0.06em] uppercase ${
                  isFailed ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                {isFailed ? 'Hata Detayı' : 'Sonuç'}
              </div>
              <p className="text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                {agent.summary}
              </p>
            </div>
          )}
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

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-medium shadow-md backdrop-blur-md transition-all outline-none hover:border-border focus:outline-none ${
        runningCount > 0
          ? 'border-sky-500/35 bg-background/90 text-foreground'
          : 'border-border/70 bg-background/85 text-foreground-muted hover:text-foreground'
      }`}
    >
      <OrbitalSpinner active={runningCount > 0} />
      <span>
        {runningCount > 0 ? `${runningCount} alt ajan çalışıyor` : `${agents.length} alt ajan`}
      </span>
    </button>
  );
}

export function AcpSubagentsPanel({
  agents,
  onClose,
}: {
  agents: readonly AgentState[];
  onClose: () => void;
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

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside className="relative flex h-full w-[340px] max-w-[45%] shrink-0 flex-col border-l border-border/60 bg-(--em-surface)">
      <style>{`
        @keyframes orkestra-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes orkestra-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes orkestra-pulse-ring {
          0% { transform: scale(0.85); opacity: 0.65; }
          70% { transform: scale(1.35); opacity: 0; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        @keyframes orkestra-bar {
          0%, 100% { transform: scaleY(0.4); opacity: 0.45; }
          50% { transform: scaleY(1); opacity: 1; }
        }
      `}</style>

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
        {sortedAgents.map((agent) => {
          const key = agent.agentId || agent.toolCallId;
          return (
            <SubagentCard
              key={key}
              agent={agent}
              expanded={expandedIds.has(key)}
              onToggle={() => toggleExpanded(key)}
              now={now}
            />
          );
        })}
      </div>
    </aside>
  );
}
