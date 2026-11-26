import {
  CODEX_TASK_UNAVAILABLE,
  readableCodexTask,
  type AgentActivityEntry,
  type AgentState,
} from '@orkestra/core/runtimes/acp/api/client';
import { Markdown } from '@orkestra/ui/react/components';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
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

function providerLabel(provider?: string): string {
  const p = (provider || '').toLowerCase();
  if (p === 'codex') return 'Codex';
  if (p === 'claude') return 'Claude';
  if (p === 'kimi') return 'Kimi';
  if (p === 'grok') return 'Grok';
  if (p === 'glm') return 'GLM';
  if (p === 'gemini') return 'Gemini';
  if (p === 'opencode') return 'OpenCode';
  if (p === 'antigravity') return 'Antigravity';
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Ajan';
}

function providerAccentGlow(provider?: string): string {
  const p = (provider || '').toLowerCase();
  if (p === 'claude') return 'rgba(251, 146, 60, 0.55)';
  if (p === 'codex') return 'rgba(52, 211, 153, 0.55)';
  if (p === 'kimi') return 'rgba(34, 211, 238, 0.55)';
  if (p === 'gemini' || p === 'antigravity') return 'rgba(99, 102, 241, 0.65)';
  return 'rgba(56, 189, 248, 0.6)';
}

/** Test uyumluluğu için korunan dalga ölçeği yardımcısı. */
const BAR_WAVE = [0.4, 0.58, 0.82, 1, 0.82, 0.58, 0.4, 0.4] as const;
export function liveBarScale(tick: number, barIndex: number): number {
  const length = BAR_WAVE.length;
  return BAR_WAVE[(((tick - barIndex * 2) % length) + length) % length] ?? 0.4;
}

function ActivityGlyph({ entry }: { entry: AgentActivityEntry }) {
  if (entry.kind === 'error') {
    return <AlertCircle className="size-3 shrink-0 text-rose-400" />;
  }
  if (entry.kind === 'thinking') {
    return <Brain className="size-3 shrink-0 text-violet-400/90" />;
  }
  if (entry.kind === 'message') {
    return <MessageSquare className="size-3 shrink-0 text-emerald-400/90" />;
  }
  if (entry.kind === 'tool') {
    return entry.title.toLowerCase().includes('komut') ? (
      <Terminal className="size-3 shrink-0 text-sky-400/90" />
    ) : (
      <Wrench className="size-3 shrink-0 text-sky-400/90" />
    );
  }
  return <Sparkles className="size-3 shrink-0 text-amber-400/90" />;
}

/** Sağlayıcı logosu + sağ alt köşe durum noktası taşıyan modern cam madalyon. */
function AgentAvatar({
  provider,
  status,
  interrupted,
  size = 'md',
}: {
  provider?: string;
  status: AgentState['status'];
  interrupted?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const isRunning = status === 'running';
  const isInterrupted = status === 'failed' && Boolean(interrupted);
  const isFailed = status === 'failed' && !isInterrupted;
  const boxClass =
    size === 'lg' ? 'size-8' : size === 'sm' ? 'size-6' : 'size-7';
  const iconPx = size === 'lg' ? 17 : size === 'sm' ? 13 : 15;

  return (
    <span
      className={`relative flex shrink-0 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/[0.1] ${boxClass}`}
    >
      {provider ? (
        <AgentIcon id={provider} size={iconPx} />
      ) : (
        <Bot className="size-3.5 text-foreground-muted" />
      )}
      <span
        className={`absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center rounded-full ring-2 ring-[#0b0b0f] ${
          isRunning
            ? 'bg-sky-400'
            : isFailed
              ? 'bg-rose-400'
              : interrupted
                ? 'bg-zinc-500'
                : 'bg-emerald-400'
        }`}
      >
        {isRunning && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/75" />
        )}
      </span>
    </span>
  );
}

/** Aktif çalışan tek bir alt ajan için şık, ipeksi cam kart. */
function LiveSubagentCard({
  agent,
  now,
  onSelect,
  onCancelSubagent,
}: {
  agent: AgentState;
  now: number;
  onSelect: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const [stopping, setStopping] = useState(false);
  const activities = agent.activities ?? [];
  const lastActivity = activities[activities.length - 1];
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const stoppable = agent.detached !== true;
  const isValidUuid = UUID_RE.test(agent.agentId);
  const canCancel = Boolean(onCancelSubagent) && stoppable && isValidUuid;

  const liveStepLine = lastActivity
    ? lastActivity.detail
      ? `${lastActivity.title} · ${lastActivity.detail}`
      : lastActivity.title
    : 'Görev hazırlanıyor…';

  const handleStop = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!canCancel || !onCancelSubagent || stopping) return;
    setStopping(true);
    try {
      await onCancelSubagent(agent.agentId);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className="group/card relative flex w-full cursor-pointer flex-col gap-2.5 overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.045] to-white/[0.015] p-3 text-left transition-all duration-200 hover:border-white/[0.15] hover:from-white/[0.06] outline-none"
    >
      {/* Üst başlık: Gerçek sağlayıcı madalyonu + isim + süre + durdur */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <AgentAvatar provider={agent.provider} status="running" size="md" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-foreground">
              {agent.name}
            </span>
            <span className="truncate text-[10.5px] text-foreground-passive">
              {agent.model || providerLabel(agent.provider)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {stoppable && (
            <button
              type="button"
              onClick={(e) => void handleStop(e)}
              disabled={!canCancel || stopping}
              title={canCancel ? 'Durdur' : 'Tekil durdurulamıyor'}
              aria-label="Durdur"
              className="flex size-6 cursor-pointer items-center justify-center rounded-full text-foreground-passive opacity-0 transition-all group-hover/card:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {stopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-2.5 fill-current" />
              )}
            </button>
          )}
          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-foreground-muted">
            {elapsed}
          </span>
        </div>
      </div>

      {/* İnce akan ışık ilerleme çubuğu */}
      <div className="relative h-[2px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="subagent-shimmer-bar absolute inset-y-0 w-2/5 rounded-full"
          style={{
            background: `linear-gradient(90deg, transparent, ${providerAccentGlow(agent.provider)}, transparent)`,
          }}
        />
      </div>

      {/* Canlı adım satırı */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-foreground/80">
          {lastActivity ? (
            <ActivityGlyph entry={lastActivity} />
          ) : (
            <Sparkles className="size-3 shrink-0 text-sky-400/80" />
          )}
          <span className="truncate">{liveStepLine}</span>
        </span>
        <ChevronRight className="size-3 shrink-0 text-foreground-passive opacity-50 transition-transform group-hover/card:translate-x-0.5 group-hover/card:opacity-90" />
      </div>
    </div>
  );
}

/** Tam panel drill-down detay ekranı — dar panelde sıkışmadan rahat okuma sağlar. */
function SubagentDetailView({
  agent,
  now,
  onBack,
  onCancelSubagent,
}: {
  agent: AgentState;
  now: number;
  onBack: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const openLink = useMarkdownLinkOpener();
  const [stepsOpen, setStepsOpen] = useState(agent.status === 'running');
  const [promptOpen, setPromptOpen] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [stopping, setStopping] = useState(false);

  const isRunning = agent.status === 'running';
  const isInterrupted = agent.status === 'failed' && agent.interrupted === true;
  const isFailed = agent.status === 'failed' && !isInterrupted;
  const activities = agent.activities ?? [];
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const effortLabel = formatEffortLabel(agent.effort);
  const prompt =
    agent.provider === 'codex'
      ? readableCodexTask(agent.prompt)
      : agent.prompt?.trim() || undefined;
  const taskText = prompt ?? (agent.provider === 'codex' ? CODEX_TASK_UNAVAILABLE : undefined);

  const metaLine = [
    agent.provider ? providerLabel(agent.provider) : null,
    agent.model || agent.role || null,
    effortLabel ? `${effortLabel} efor` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const stoppable = agent.detached !== true;
  const canCancel = isRunning && Boolean(onCancelSubagent) && stoppable && UUID_RE.test(agent.agentId);

  const handleStop = async () => {
    if (!canCancel || !onCancelSubagent || stopping) return;
    setStopping(true);
    try {
      await onCancelSubagent(agent.agentId);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="mt-2.5 flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0b0f]">
      {/* Üst navigasyon */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] px-2.5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-foreground-muted transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          <span>Geri</span>
        </button>

        <div className="flex items-center gap-1.5">
          {(isRunning || elapsed !== '0s') && (
            <span className="font-mono text-[11px] tabular-nums text-foreground-passive">
              {elapsed}
            </span>
          )}
          {isRunning && canCancel && (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={stopping}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-2.5 fill-current" />
              )}
              <span>Durdur</span>
            </button>
          )}
        </div>
      </div>

      {/* Gövde */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* Ajan kimlik kartı */}
        <div className="flex items-center gap-2.5">
          <AgentAvatar
            provider={agent.provider}
            status={agent.status}
            interrupted={isInterrupted}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">{agent.name}</div>
            {metaLine && (
              <div className="truncate text-[11px] text-foreground-passive">{metaLine}</div>
            )}
          </div>
        </div>

        {/* Yanıt / Canlı durum */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] font-medium tracking-wide text-foreground-passive uppercase">
              {isFailed ? 'Hata' : isRunning ? 'Durum' : 'Yanıt'}
            </span>
            {agent.summary && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(agent.summary ?? '').then(() => {
                    setCopiedResponse(true);
                    window.setTimeout(() => setCopiedResponse(false), 1500);
                  });
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-foreground-passive hover:bg-white/[0.06] hover:text-foreground"
              >
                {copiedResponse ? (
                  <>
                    <Check className="size-3 text-emerald-400" />
                    <span className="text-emerald-400">Kopyalandı</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    <span>Kopyala</span>
                  </>
                )}
              </button>
            )}
          </div>

          {isRunning && !agent.summary ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-xs text-foreground-muted">
              <Loader2 className="size-3.5 animate-spin text-sky-400" />
              <span>Alt ajan yanıt hazırlıyor…</span>
            </div>
          ) : agent.summary ? (
            <div
              className={`max-h-64 overflow-y-auto rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed break-words text-foreground/90 select-text [&_*:last-child]:mb-0 ${
                isFailed
                  ? 'border-rose-500/25 bg-rose-500/[0.05]'
                  : 'border-white/[0.07] bg-white/[0.025]'
              }`}
            >
              <Markdown content={agent.summary} variant="compact" onOpenLink={openLink} />
            </div>
          ) : (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11.5px] text-foreground-passive">
              Metin yanıtı dönmedi.
            </div>
          )}
        </div>

        {/* Adımlar (katlanabilir) */}
        {activities.length > 0 && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <button
              type="button"
              onClick={() => setStepsOpen((v) => !v)}
              className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-[11.5px] font-medium text-foreground-muted hover:text-foreground"
            >
              <span>Adımlar ({activities.length})</span>
              {stepsOpen ? (
                <ChevronDown className="size-3.5 opacity-60" />
              ) : (
                <ChevronRight className="size-3.5 opacity-60" />
              )}
            </button>
            {stepsOpen && (
              <div className="relative max-h-48 space-y-2 overflow-y-auto border-t border-white/[0.06] px-3 py-2.5 pl-5 before:absolute before:top-3 before:bottom-3 before:left-[15px] before:w-px before:bg-white/[0.08]">
                {activities.map((entry) => (
                  <div key={entry.id} className="relative pl-3">
                    <span className="absolute top-0.5 -left-[11px] flex size-4 items-center justify-center rounded-full bg-[#0b0b0f]">
                      <ActivityGlyph entry={entry} />
                    </span>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px] font-medium text-foreground/90">
                        {entry.title}
                      </span>
                      {entry.timestamp && (
                        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-foreground-passive">
                          {formatTime(entry.timestamp)}
                        </span>
                      )}
                    </div>
                    {entry.detail && (
                      <p className="mt-0.5 text-[10.5px] leading-snug break-words text-foreground-muted">
                        {entry.detail}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Gönderilen Talimat (katlanabilir) */}
        {taskText && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <div className="flex items-center justify-between px-3 py-2">
              <button
                type="button"
                onClick={() => setPromptOpen((v) => !v)}
                className="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-[11.5px] font-medium text-foreground-muted hover:text-foreground"
              >
                {promptOpen ? (
                  <ChevronDown className="size-3.5 opacity-60" />
                ) : (
                  <ChevronRight className="size-3.5 opacity-60" />
                )}
                <span>Talimat</span>
              </button>
              {prompt && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(prompt).then(() => {
                      setCopiedPrompt(true);
                      window.setTimeout(() => setCopiedPrompt(false), 1500);
                    });
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-foreground-passive hover:bg-white/[0.06] hover:text-foreground"
                >
                  {copiedPrompt ? (
                    <Check className="size-3 text-emerald-400" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              )}
            </div>
            {promptOpen && (
              <div className="max-h-40 overflow-y-auto border-t border-white/[0.06] px-3 py-2 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/80 select-text">
                {taskText}
              </div>
            )}
          </div>
        )}
      </div>
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
      className={`pointer-events-auto inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-medium shadow-md backdrop-blur-md transition-all outline-none ${
        runningCount > 0
          ? 'border-sky-500/35 bg-background/90 text-foreground'
          : 'border-border/70 bg-background/85 text-foreground-muted hover:text-foreground'
      }`}
    >
      <span
        className={`size-2 rounded-full ${
          runningCount > 0 ? 'animate-pulse bg-sky-400' : 'bg-emerald-400/80'
        }`}
      />
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
  embedded = false,
  mode = 'all',
}: {
  agents: readonly AgentState[];
  onClose?: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
  embedded?: boolean;
  mode?: 'live' | 'history' | 'all';
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAllFinished, setShowAllFinished] = useState(false);
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

  const agentKey = (agent: AgentState) => agent.toolCallId || agent.agentId;
  const selectedAgent = selectedKey
    ? sortedAgents.find((a) => agentKey(a) === selectedKey) ?? null
    : null;

  const runningAgents = sortedAgents.filter((agent) => agent.status === 'running');
  const finishedAgents = sortedAgents.filter((agent) => agent.status !== 'running');

  // Seçili bir ajan varsa tam panel detay görünümünü aç (drill-down)
  if (selectedAgent) {
    return (
      <SubagentDetailView
        agent={selectedAgent}
        now={now}
        onBack={() => setSelectedKey(null)}
        onCancelSubagent={onCancelSubagent}
      />
    );
  }

  // 'live' modunda yalnızca şu an çalışan alt ajanlar şık canlı kartlar olarak görünür;
  // işleri bitince bu alan kendiliğinden tertemiz kaybolur.
  if (mode === 'live') {
    if (runningAgents.length === 0) return null;
    return (
      <div className="mt-2.5 flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto">
        {runningAgents.map((agent) => {
          const key = agentKey(agent);
          return (
            <LiveSubagentCard
              key={key}
              agent={agent}
              now={now}
              onSelect={() => setSelectedKey(key)}
              onCancelSubagent={onCancelSubagent}
            />
          );
        })}
      </div>
    );
  }

  // Geçmiş inceleme görünümü ('history' veya 'all')
  const successCount = finishedAgents.filter((a) => a.status === 'completed' && !a.interrupted).length;
  const failCount = finishedAgents.filter((a) => a.status === 'failed' && !a.interrupted).length;
  const MAX_VISIBLE = 6;
  const listToRender = showAllFinished ? sortedAgents : sortedAgents.slice(0, MAX_VISIBLE);
  const hiddenCount = sortedAgents.length - listToRender.length;

  return (
    <aside
      className={
        embedded
          ? 'relative mt-2.5 flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0b0f]'
          : 'relative flex h-full w-[340px] max-w-[45%] shrink-0 flex-col border-l border-border/60 bg-(--em-surface)'
      }
    >
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3.5 py-2.5">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <Layers className="size-3.5 text-foreground-passive" />
            <h2 className="text-xs font-medium text-foreground">
              {mode === 'history' ? 'Alt ajan geçmişi' : 'Alt ajanlar'}
            </h2>
          </div>
          <span className="mt-0.5 text-[10.5px] text-foreground-passive">
            {runningCount > 0 ? `${runningCount} çalışıyor · ` : ''}
            {successCount > 0 ? `${successCount} tamamlandı` : ''}
            {failCount > 0 ? `${successCount > 0 ? ' · ' : ''}${failCount} hata` : ''}
          </span>
        </div>

        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            title="Kapat"
            aria-label="Kapat"
            className="flex size-6 cursor-pointer items-center justify-center rounded-lg text-foreground-passive transition-colors hover:bg-white/[0.07] hover:text-foreground"
          >
            {embedded ? <X className="size-3.5" /> : <PanelRightClose className="size-3.5" />}
          </button>
        ) : null}
      </header>

      <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {listToRender.map((agent) => {
          const key = agentKey(agent);
          const isRunning = agent.status === 'running';
          const isFailed = agent.status === 'failed' && !agent.interrupted;
          const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
          const showElapsed = isRunning || elapsed !== '0s';

          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              className="group/item flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <AgentAvatar
                  provider={agent.provider}
                  status={agent.status}
                  interrupted={agent.interrupted}
                  size="sm"
                />
                <div className="flex min-w-0 flex-col">
                  <span
                    className={`truncate text-xs font-medium ${
                      isFailed ? 'text-rose-300' : 'text-foreground/90 group-hover/item:text-foreground'
                    }`}
                  >
                    {agent.name}
                  </span>
                  <span className="truncate text-[10.5px] text-foreground-passive">
                    {agent.model || providerLabel(agent.provider)}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 text-[10.5px] text-foreground-passive">
                {showElapsed && <span className="font-mono tabular-nums">{elapsed}</span>}
                <ChevronRight className="size-3.5 opacity-40 transition-transform group-hover/item:translate-x-0.5 group-hover/item:opacity-80" />
              </div>
            </button>
          );
        })}

        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAllFinished(true)}
            className="mt-1 flex w-full cursor-pointer items-center justify-center rounded-xl py-1.5 text-[11px] font-medium text-foreground-passive transition-colors hover:bg-white/[0.04] hover:text-foreground"
          >
            +{hiddenCount} alt ajan daha göster
          </button>
        ) : showAllFinished && sortedAgents.length > MAX_VISIBLE ? (
          <button
            type="button"
            onClick={() => setShowAllFinished(false)}
            className="mt-1 flex w-full cursor-pointer items-center justify-center rounded-xl py-1.5 text-[11px] font-medium text-foreground-passive transition-colors hover:bg-white/[0.04] hover:text-foreground"
          >
            Daha az göster
          </button>
        ) : null}
      </div>
    </aside>
  );
}
