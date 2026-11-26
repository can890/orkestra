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
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  Layers,
  Loader2,
  Maximize2,
  PanelRightClose,
  Search,
  Square,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
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

function formatModelLabel(model?: string): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  if (trimmed === 'opus') return 'Opus';
  if (trimmed === 'sonnet') return 'Sonnet';
  if (trimmed === 'haiku') return 'Haiku';
  return trimmed;
}

function summarizeMissionLine(taskText?: string, agentName?: string): string | null {
  if (!taskText || taskText === CODEX_TASK_UNAVAILABLE) return null;
  const singleLine = taskText
    .replace(/[#*`>_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return null;
  if (agentName && singleLine.toLowerCase() === agentName.trim().toLowerCase()) return null;
  return singleLine;
}

/**
 * Bazı alt ajan yanıtları dıştan tırnak (`"..."`) ile sarılı dönebiliyor;
 * tüm metin tek bir dış tırnak çiftiyle sarılıysa temizler.
 */
function cleanSubagentText(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.length >= 4 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith('“') && trimmed.endsWith('”')))
  ) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner) return inner;
  }
  return trimmed;
}

function resolvePromptText(agent: AgentState): { prompt?: string; taskText?: string } {
  const prompt =
    agent.provider === 'codex'
      ? readableCodexTask(agent.prompt)
      : cleanSubagentText(agent.prompt);
  const taskText = prompt ?? (agent.provider === 'codex' ? CODEX_TASK_UNAVAILABLE : undefined);
  return { prompt, taskText };
}

/** Test uyumluluğu için korunan dalga ölçeği yardımcısı. */
const BAR_WAVE = [0.4, 0.58, 0.82, 1, 0.82, 0.58, 0.4, 0.4] as const;
export function liveBarScale(tick: number, barIndex: number): number {
  const length = BAR_WAVE.length;
  return BAR_WAVE[(((tick - barIndex * 2) % length) + length) % length] ?? 0.4;
}

type NormalizedStepCategory = 'command' | 'read' | 'edit' | 'search' | 'error' | 'other';

interface NormalizedSubagentStep {
  id: string;
  category: NormalizedStepCategory;
  label: string;
  preview?: string;
  fullDetail?: string;
  timestamp?: number;
}

const AGGREGATE_GROUP_TITLE_RE =
  /^(?:\d+|bir)\s+(?:komut|dosya|araç|arama)\b|komut çalıştırıldı|dosya okundu|araç kullanıldı/i;

function shortFileName(raw: string): string {
  const cleaned = raw.replace(/^["'`]|["'`]$/g, '').trim();
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cleaned;
}

function compactCommandPreview(cmd: string): string {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  // Başlangıçtaki gereksiz "cd /uzun/yol &&" önekini sadeleştir
  const withoutCd = oneLine.replace(/^cd\s+[^&;]+&&\s*/i, '').trim();
  return withoutCd || oneLine;
}

/**
 * Alt ajan ham araç adımlarını ana ajanın sohbetindeki sade ve okunaklı biçime dönüştürür:
 * tekrarlayan grup başlıklarını ayıklar, uzun dosya yollarını dosya adına indirger,
 * çok satırlı bash komutlarını tek satırlık özetle gösterir.
 */
function normalizeSubagentSteps(activities: readonly AgentActivityEntry[]): NormalizedSubagentStep[] {
  const filtered = activities.filter((entry) => entry.kind !== 'thinking');
  const hasLeafSteps = filtered.some((entry) => !AGGREGATE_GROUP_TITLE_RE.test(entry.title.trim()));

  const result: NormalizedSubagentStep[] = [];
  for (const entry of filtered) {
    const title = entry.title.trim();
    const detail = entry.detail?.trim();
    if (hasLeafSteps && AGGREGATE_GROUP_TITLE_RE.test(title)) continue;

    if (entry.kind === 'error' || entry.status === 'error') {
      result.push({
        id: entry.id,
        category: 'error',
        label: 'Hata',
        preview: detail || title,
        fullDetail: detail && detail !== title ? `${title}\n${detail}` : title,
        timestamp: entry.timestamp,
      });
      continue;
    }

    const readMatch = title.match(/^(?:Read|Dosya oku|Oku)\s+(.+)$/i);
    if (readMatch || /^(?:read|dosya oku)$/i.test(title)) {
      const target = readMatch?.[1] ?? detail ?? '';
      result.push({
        id: entry.id,
        category: 'read',
        label: 'Dosya okundu',
        preview: target ? shortFileName(target) : undefined,
        fullDetail: target || undefined,
        timestamp: entry.timestamp,
      });
      continue;
    }

    const editMatch = title.match(/^(?:Edit|Write|Modify|Create|Düzenle|Oluştur|Yaz)\s+(.+)$/i);
    if (editMatch || /^(?:edit|write|modify|create|dosya düzenle|dosya oluştur)$/i.test(title)) {
      const target = editMatch?.[1] ?? detail ?? '';
      result.push({
        id: entry.id,
        category: 'edit',
        label: 'Dosya düzenlendi',
        preview: target ? shortFileName(target) : undefined,
        fullDetail: target || undefined,
        timestamp: entry.timestamp,
      });
      continue;
    }

    const searchMatch = title.match(/^(?:Search|Grep|Glob|Ara)\s+(.+)$/i);
    if (searchMatch || /^(?:search|grep|glob|ara)$/i.test(title)) {
      const query = searchMatch?.[1] ?? detail ?? '';
      result.push({
        id: entry.id,
        category: 'search',
        label: 'Arama yapıldı',
        preview: query || undefined,
        fullDetail: query || undefined,
        timestamp: entry.timestamp,
      });
      continue;
    }

    const looksLikeShell =
      /^(?:cd |ls |cat |head |tail |sed |grep |rg |find |python|node |pnpm |npm |git |ffmpeg|ffprobe|wc |echo |mkdir |cp |mv |rm |bash |sh )/i.test(
        title
      ) ||
      title.includes('&&') ||
      title.includes(' | ') ||
      title.toLowerCase().includes('komut');

    if (looksLikeShell) {
      const rawCmd =
        title.toLowerCase().includes('komut') && detail ? detail : detail || title;
      result.push({
        id: entry.id,
        category: 'command',
        label: 'Komut çalıştırıldı',
        preview: compactCommandPreview(rawCmd),
        fullDetail: rawCmd,
        timestamp: entry.timestamp,
      });
      continue;
    }

    result.push({
      id: entry.id,
      category: 'other',
      label: title,
      preview: detail && detail !== title ? detail : undefined,
      fullDetail: detail && detail !== title ? detail : undefined,
      timestamp: entry.timestamp,
    });
  }
  return result;
}

function summarizeNormalizedSteps(steps: readonly NormalizedSubagentStep[]): string {
  const counts = { command: 0, read: 0, edit: 0, search: 0, other: 0 };
  for (const s of steps) {
    if (s.category === 'command') counts.command += 1;
    else if (s.category === 'read') counts.read += 1;
    else if (s.category === 'edit') counts.edit += 1;
    else if (s.category === 'search') counts.search += 1;
    else counts.other += 1;
  }
  const parts: string[] = [];
  if (counts.command > 0) parts.push(`${counts.command} komut çalıştırıldı`);
  if (counts.read > 0) parts.push(`${counts.read} dosya okundu`);
  if (counts.edit > 0) parts.push(`${counts.edit} dosya düzenlendi`);
  if (counts.search > 0) parts.push(`${counts.search} arama yapıldı`);
  if (counts.other > 0 && parts.length === 0) parts.push(`${counts.other} araç kullanıldı`);
  return parts.length > 0 ? parts.join(', ') : `${steps.length} adım`;
}

function StepCategoryGlyph({ category }: { category: NormalizedStepCategory }) {
  if (category === 'error') return <AlertCircle className="size-3 shrink-0 text-rose-400" />;
  if (category === 'command') return <Terminal className="size-3 shrink-0 text-foreground-passive" />;
  if (category === 'read') return <FileText className="size-3 shrink-0 text-foreground-passive" />;
  if (category === 'edit') return <FilePen className="size-3 shrink-0 text-emerald-400/80" />;
  if (category === 'search') return <Search className="size-3 shrink-0 text-foreground-passive" />;
  return <Wrench className="size-3 shrink-0 text-foreground-passive" />;
}

/** Ana ajanın sohbetindeki "17 komut çalıştırıldı ›" tarzında sade, tek satırlı adım akışı. */
function SubagentStepsSection({
  activities,
  compact = false,
}: {
  activities: readonly AgentActivityEntry[];
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const steps = useMemo(() => normalizeSubagentSteps(activities), [activities]);

  if (steps.length === 0) return null;
  const summaryLabel = summarizeNormalizedSteps(steps);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 font-medium text-foreground-passive transition-colors hover:bg-white/[0.05] hover:text-foreground ${
          compact ? 'text-[11px]' : 'text-xs'
        }`}
      >
        <span>{summaryLabel}</span>
        {open ? (
          <ChevronDown className="size-3 opacity-70" />
        ) : (
          <ChevronRight className="size-3 opacity-70" />
        )}
      </button>

      {open && (
        <div
          className={`space-y-0.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5 ${
            compact ? 'max-h-52 overflow-y-auto' : 'max-h-72 overflow-y-auto'
          }`}
        >
          {steps.map((step) => {
            const isExpanded = expandedRowId === step.id;
            const hasExtra = Boolean(
              step.fullDetail && step.fullDetail !== step.preview && step.fullDetail.length > 50
            );
            return (
              <div key={step.id} className="rounded-lg transition-colors hover:bg-white/[0.04]">
                <button
                  type="button"
                  onClick={() => {
                    if (hasExtra) setExpandedRowId(isExpanded ? null : step.id);
                  }}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left ${
                    hasExtra ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <StepCategoryGlyph category={step.category} />
                  <span
                    className={`shrink-0 font-medium text-foreground/75 ${
                      compact ? 'text-[11px]' : 'text-[11.5px]'
                    }`}
                  >
                    {step.label}
                  </span>
                  {step.preview && (
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-foreground-passive ${
                        compact ? 'text-[10.5px]' : 'text-[11px]'
                      }`}
                    >
                      {step.preview}
                    </span>
                  )}
                  {step.timestamp && (
                    <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-foreground-passive/70">
                      {formatTime(step.timestamp)}
                    </span>
                  )}
                </button>
                {isExpanded && step.fullDetail && (
                  <pre className="mx-2 mb-1.5 overflow-x-auto rounded-lg bg-black/40 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-foreground/80 select-text">
                    {step.fullDetail}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
  const boxClass = size === 'lg' ? 'size-9' : size === 'sm' ? 'size-6' : 'size-7';
  const iconPx = size === 'lg' ? 18 : size === 'sm' ? 13 : 15;

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
              : isInterrupted
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

/** Aktif çalışan tek bir alt ajan satırı: başlık, model/efor, gönderilme amacı ve canlı adım. */
function LiveSubagentRow({
  agent,
  now,
  onSelect,
  onExpand,
  onCancelSubagent,
}: {
  agent: AgentState;
  now: number;
  onSelect: () => void;
  onExpand: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const [stopping, setStopping] = useState(false);
  const activities = agent.activities ?? [];
  const normalizedSteps = useMemo(() => normalizeSubagentSteps(activities), [activities]);
  const lastStep = normalizedSteps[normalizedSteps.length - 1];
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const stoppable = agent.detached !== true;
  const isValidUuid = UUID_RE.test(agent.agentId);
  const canCancel = Boolean(onCancelSubagent) && stoppable && isValidUuid;

  const { taskText } = resolvePromptText(agent);
  const missionLine = summarizeMissionLine(taskText, agent.name);
  const modelLabel = formatModelLabel(agent.model);
  const effortLabel = formatEffortLabel(agent.effort);
  const metaText = [
    providerLabel(agent.provider),
    modelLabel,
    effortLabel ? `${effortLabel} efor` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const liveStepLine = lastStep
    ? lastStep.preview
      ? `${lastStep.label}: ${lastStep.preview}`
      : lastStep.label
    : null;

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
      className="group/card flex w-full cursor-pointer flex-col gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.035] outline-none"
    >
      {/* 1. Satır: Gerçek görev adı + süre + hover büyüt/durdur */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
            {agent.provider ? (
              <AgentIcon id={agent.provider} size={12} />
            ) : (
              <Bot className="size-3 text-foreground-muted" />
            )}
          </span>
          <span className="truncate text-[12px] font-medium text-foreground">{agent.name}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            title="Büyük pencerede aç"
            aria-label="Büyük pencerede aç"
            className="flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-passive opacity-0 transition-all group-hover/card:opacity-100 hover:bg-white/[0.08] hover:text-foreground focus:opacity-100"
          >
            <Maximize2 className="size-3" />
          </button>
          {stoppable && canCancel && (
            <button
              type="button"
              onClick={(e) => void handleStop(e)}
              disabled={stopping}
              title="Durdur"
              aria-label="Durdur"
              className="flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-passive opacity-0 transition-all group-hover/card:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 focus:opacity-100 disabled:opacity-40"
            >
              {stopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-2.5 fill-current" />
              )}
            </button>
          )}
          <span className="font-mono text-[10.5px] tabular-nums text-foreground-passive">
            {elapsed}
          </span>
        </div>
      </div>

      {/* 2. Satır: Sağlayıcı · Model · Efor */}
      <div className="truncate pl-7 text-[10.5px] text-foreground-passive">{metaText}</div>

      {/* 3. Satır: Ne için gönderildi (prompt özeti) */}
      {missionLine && (
        <p className="line-clamp-2 pl-7 text-[11px] leading-[1.45] text-foreground/75">
          {missionLine}
        </p>
      )}

      {/* 4. Satır: Gerçek canlı adım (sabit dönen ikon + adım sayısı, zıplayan çubuk yok) */}
      <div className="flex items-center justify-between gap-2 pl-7 text-[10.5px] text-foreground-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="size-3 shrink-0 animate-spin text-sky-400/90" />
          <span className="truncate">
            {liveStepLine
              ? `${normalizedSteps.length} adım · ${liveStepLine}`
              : 'Çalışıyor…'}
          </span>
        </span>
        <ChevronRight className="size-3 shrink-0 text-foreground-passive opacity-45 transition-transform group-hover/card:translate-x-0.5 group-hover/card:opacity-90" />
      </div>
    </div>
  );
}

/** Sağ dar panelde sohbet akışı tarzında şık detay görünümü + tek tıkla büyütme. */
function SubagentDetailView({
  agent,
  now,
  onBack,
  onExpand,
  onCancelSubagent,
}: {
  agent: AgentState;
  now: number;
  onBack: () => void;
  onExpand: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const openLink = useMarkdownLinkOpener();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [stopping, setStopping] = useState(false);

  const isRunning = agent.status === 'running';
  const isInterrupted = agent.status === 'failed' && agent.interrupted === true;
  const isFailed = agent.status === 'failed' && !isInterrupted;
  const activities = agent.activities ?? [];
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const effortLabel = formatEffortLabel(agent.effort);
  const { prompt, taskText } = resolvePromptText(agent);
  const cleanedSummary = cleanSubagentText(agent.summary);
  const isLongPrompt = Boolean(taskText && (taskText.length > 180 || taskText.split('\n').length > 4));

  const metaLine = [
    agent.provider ? providerLabel(agent.provider) : null,
    agent.model || agent.role || null,
    effortLabel ? `${effortLabel}` : null,
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
      {/* Üst bar: Geri + süre + durdur + Büyüt */}
      <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-white/[0.06] px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-medium text-foreground-muted transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          <span>Geri</span>
        </button>

        <div className="flex items-center gap-1">
          {(isRunning || elapsed !== '0s') && (
            <span className="px-1 font-mono text-[10.5px] tabular-nums text-foreground-passive">
              {elapsed}
            </span>
          )}
          {isRunning && canCancel && (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={stopping}
              title="Durdur"
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-300 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-2.5 fill-current" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onExpand}
            title="Büyük pencerede aç"
            aria-label="Büyük pencerede aç"
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <Maximize2 className="size-3" />
            <span>Büyüt</span>
          </button>
        </div>
      </div>

      {/* Tek akışlı sohbet tarzı gövde (iç içe kutu yok) */}
      <div className="flex-1 space-y-3.5 overflow-y-auto px-3 py-3">
        {/* Ajan kimlik satırı */}
        <div className="flex items-start gap-2.5">
          <AgentAvatar
            provider={agent.provider}
            status={agent.status}
            interrupted={isInterrupted}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[12.5px] leading-snug font-semibold text-foreground">
              {agent.name}
            </div>
            {metaLine && (
              <div className="mt-0.5 truncate text-[10.5px] text-foreground-passive">{metaLine}</div>
            )}
          </div>
        </div>

        {/* 1) Verilen Prompt — Şık kullanıcı mesaj balonu */}
        {taskText && (
          <div className="rounded-2xl rounded-tr-md border border-white/[0.06] bg-white/[0.045] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium tracking-wide text-foreground-passive uppercase">
                Verilen prompt
              </span>
              {prompt && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(prompt).then(() => {
                      setCopiedPrompt(true);
                      window.setTimeout(() => setCopiedPrompt(false), 1500);
                    });
                  }}
                  title="Promptu kopyala"
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] text-foreground-passive transition-colors hover:bg-white/[0.07] hover:text-foreground"
                >
                  {copiedPrompt ? (
                    <Check className="size-2.5 text-emerald-400" />
                  ) : (
                    <Copy className="size-2.5" />
                  )}
                </button>
              )}
            </div>

            <div className="relative">
              <div
                className={`text-[11.5px] leading-[1.55] break-words text-foreground/85 select-text [&_*:last-child]:mb-0 [&_code]:break-all [&_code]:rounded [&_code]:bg-white/[0.08] [&_code]:px-1 [&_code]:py-[1px] [&_code]:text-[10.5px] ${
                  !promptExpanded && isLongPrompt ? 'max-h-[5.5rem] overflow-hidden' : ''
                }`}
              >
                <Markdown
                  content={taskText}
                  variant="compact"
                  allowHtml={false}
                  onOpenLink={openLink}
                />
              </div>
              {!promptExpanded && isLongPrompt && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#16161c] to-transparent" />
              )}
            </div>

            {isLongPrompt && (
              <button
                type="button"
                onClick={() => setPromptExpanded((v) => !v)}
                className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[10.5px] font-medium text-foreground-muted transition-colors hover:text-foreground"
              >
                {promptExpanded ? 'Daralt' : 'Devamını gör'}
              </button>
            )}
          </div>
        )}

        {/* 2) Çalışma adımları — Ana ajan tarzında sade gruplanmış özet */}
        <SubagentStepsSection activities={activities} compact />

        {/* 3) Alt Ajan Yanıtı — Çerçevesiz, ferah editoryal akış */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-foreground-passive uppercase">
              <span
                className={`size-1.5 rounded-full ${
                  isRunning
                    ? 'animate-pulse bg-sky-400'
                    : isFailed
                      ? 'bg-rose-400'
                      : isInterrupted
                        ? 'bg-zinc-500'
                        : 'bg-emerald-400'
                }`}
              />
              {isFailed ? 'Hata' : isRunning ? 'Yanıt hazırlanıyor' : 'Yanıt'}
            </span>
            {cleanedSummary && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(cleanedSummary).then(() => {
                    setCopiedResponse(true);
                    window.setTimeout(() => setCopiedResponse(false), 1500);
                  });
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-foreground-passive transition-colors hover:bg-white/[0.06] hover:text-foreground"
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

          {isRunning && !cleanedSummary ? (
            <div className="flex items-center gap-2 py-2 text-xs text-foreground-muted">
              <Loader2 className="size-3.5 animate-spin text-sky-400" />
              <span>Alt ajan yanıt oluşturuyor…</span>
            </div>
          ) : cleanedSummary ? (
            <div
              className={`text-[12px] leading-[1.62] break-words select-text [&_*:last-child]:mb-0 [&_code]:break-all [&_code]:rounded-[5px] [&_code]:bg-white/[0.07] [&_code]:px-1.5 [&_code]:py-[1px] [&_code]:text-[11px] [&_code]:font-normal [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-white/[0.04] [&_pre]:p-2.5 [&_pre]:text-[11px] ${
                isFailed
                  ? 'rounded-xl border border-rose-500/20 bg-rose-500/[0.05] px-3 py-2.5 text-rose-100/90'
                  : 'text-foreground/90'
              }`}
            >
              <Markdown
                content={cleanedSummary}
                variant="compact"
                allowHtml={false}
                onOpenLink={openLink}
              />
            </div>
          ) : (
            <div className="py-1 text-[11.5px] text-foreground-passive">
              Metin yanıtı dönmedi.
            </div>
          )}
        </div>
      </div>

      {/* Alt hızlı büyütme çubuğu */}
      <div className="shrink-0 border-t border-white/[0.06] px-2.5 py-2">
        <button
          type="button"
          onClick={onExpand}
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-white/[0.04] py-1.5 text-[11px] font-medium text-foreground-muted transition-colors hover:bg-white/[0.08] hover:text-foreground"
        >
          <Maximize2 className="size-3" />
          <span>Büyük pencerede detaylı incele</span>
        </button>
      </div>
    </div>
  );
}

/** Tam boyutlu, ferah alt ajan inceleme penceresi (Modal). */
function SubagentExpandedModal({
  agents,
  selectedIndex,
  now,
  onSelectIndex,
  onClose,
  onCancelSubagent,
}: {
  agents: readonly AgentState[];
  selectedIndex: number;
  now: number;
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  onCancelSubagent?: (runId: string) => Promise<void> | void;
}) {
  const openLink = useMarkdownLinkOpener();
  const agent = agents[selectedIndex];
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    setCopiedPrompt(false);
    setCopiedResponse(false);
    setStopping(false);
  }, [agent?.agentId, agent?.toolCallId, agent?.status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (agents.length <= 1) return;
      const selection = window.getSelection()?.toString();
      if (selection) return;
      if (event.key === 'ArrowLeft' && selectedIndex > 0) {
        event.preventDefault();
        onSelectIndex(selectedIndex - 1);
      } else if (event.key === 'ArrowRight' && selectedIndex < agents.length - 1) {
        event.preventDefault();
        onSelectIndex(selectedIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [agents.length, selectedIndex, onClose, onSelectIndex]);

  if (!agent || typeof document === 'undefined') return null;

  const isRunning = agent.status === 'running';
  const isInterrupted = agent.status === 'failed' && agent.interrupted === true;
  const isFailed = agent.status === 'failed' && !isInterrupted;
  const activities = agent.activities ?? [];
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  const effortLabel = formatEffortLabel(agent.effort);
  const { prompt, taskText } = resolvePromptText(agent);
  const cleanedSummary = cleanSubagentText(agent.summary);
  const stoppable = agent.detached !== true;
  const canCancel = isRunning && Boolean(onCancelSubagent) && stoppable && UUID_RE.test(agent.agentId);

  const statusPill = isRunning
    ? { label: 'Çalışıyor', cls: 'bg-sky-500/15 text-sky-300 border-sky-400/25' }
    : isFailed
      ? { label: 'Hata', cls: 'bg-rose-500/15 text-rose-300 border-rose-400/25' }
      : isInterrupted
        ? { label: 'Durduruldu', cls: 'bg-white/[0.06] text-foreground-muted border-white/[0.1]' }
        : { label: 'Tamamlandı', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/25' };

  const handleStop = async () => {
    if (!canCancel || !onCancelSubagent || stopping) return;
    setStopping(true);
    try {
      await onCancelSubagent(agent.agentId);
    } finally {
      setStopping(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={agent.name}
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-5 backdrop-blur-md"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(86vh,820px)] w-[min(92vw,880px)] flex-col overflow-hidden rounded-3xl border border-white/[0.1] bg-[#09090d] shadow-[0_32px_90px_-12px_rgba(0,0,0,0.9)]"
      >
        {/* Modal Üst Başlık */}
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/[0.07] px-6 py-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <AgentAvatar
              provider={agent.provider}
              status={agent.status}
              interrupted={isInterrupted}
              size="lg"
            />
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                {agent.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground-passive">
                <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${statusPill.cls}`}>
                  {statusPill.label}
                </span>
                <span>{providerLabel(agent.provider)}</span>
                {agent.model && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="text-foreground-muted">{agent.model}</span>
                  </>
                )}
                {effortLabel && (
                  <>
                    <span className="opacity-40">·</span>
                    <span>{effortLabel} efor</span>
                  </>
                )}
                {(isRunning || elapsed !== '0s') && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="font-mono tabular-nums">{elapsed}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {agents.length > 1 && (
              <div className="flex items-center gap-0.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-0.5">
                <button
                  type="button"
                  disabled={selectedIndex <= 0}
                  onClick={() => onSelectIndex(selectedIndex - 1)}
                  title="Önceki alt ajan (←)"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="px-1.5 font-mono text-[11px] tabular-nums text-foreground-passive">
                  {selectedIndex + 1}/{agents.length}
                </span>
                <button
                  type="button"
                  disabled={selectedIndex >= agents.length - 1}
                  onClick={() => onSelectIndex(selectedIndex + 1)}
                  title="Sonraki alt ajan (→)"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            )}

            {isRunning && canCancel && (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
              >
                {stopping ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
                <span>Durdur</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              title="Kapat (Esc)"
              aria-label="Kapat"
              className="flex size-8 cursor-pointer items-center justify-center rounded-xl text-foreground-passive transition-colors hover:bg-white/[0.08] hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        {/* Modal Gövde — Ferah sohbet & okuma düzeni */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto w-full max-w-[740px] space-y-6">
            {/* Verilen Prompt Kartı */}
            {taskText && (
              <section className="rounded-2xl rounded-tr-md border border-white/[0.08] bg-white/[0.04] px-5 py-4">
                <div className="mb-2.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium tracking-wide text-foreground-passive uppercase">
                    Verilen prompt
                  </span>
                  {prompt && (
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(prompt).then(() => {
                          setCopiedPrompt(true);
                          window.setTimeout(() => setCopiedPrompt(false), 1500);
                        });
                      }}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-foreground-passive transition-colors hover:bg-white/[0.07] hover:text-foreground"
                    >
                      {copiedPrompt ? (
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
                <div className="text-[13.5px] leading-[1.68] break-words text-foreground/90 select-text [&_*:last-child]:mb-0 [&_code]:rounded-md [&_code]:bg-white/[0.08] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[12px]">
                  <Markdown
                    content={taskText}
                    variant="compact"
                    allowHtml={false}
                    onOpenLink={openLink}
                  />
                </div>
              </section>
            )}

            {/* Çalışma Adımları — Ana ajan tarzında sade gruplanmış özet */}
            <SubagentStepsSection activities={activities} />

            {/* Alt Ajan Yanıtı */}
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${
                      isRunning
                        ? 'animate-pulse bg-sky-400'
                        : isFailed
                          ? 'bg-rose-400'
                          : isInterrupted
                            ? 'bg-zinc-500'
                            : 'bg-emerald-400'
                    }`}
                  />
                  <span className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
                    {isFailed ? 'Hata detayı' : isRunning ? 'Canlı yanıt' : 'Alt ajan yanıtı'}
                  </span>
                </div>
                {cleanedSummary && (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(cleanedSummary).then(() => {
                        setCopiedResponse(true);
                        window.setTimeout(() => setCopiedResponse(false), 1500);
                      });
                    }}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-foreground-muted transition-colors hover:bg-white/[0.07] hover:text-foreground"
                  >
                    {copiedResponse ? (
                      <>
                        <Check className="size-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Kopyalandı</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5" />
                        <span>Yanıtı kopyala</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {isRunning && !cleanedSummary ? (
                <div className="flex items-center gap-2.5 py-4 text-sm text-foreground-muted">
                  <Loader2 className="size-4 animate-spin text-sky-400" />
                  <span>Alt ajan yanıt hazırlıyor…</span>
                </div>
              ) : cleanedSummary ? (
                <div
                  className={`select-text ${
                    isFailed
                      ? 'rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] p-5 text-rose-100/95'
                      : 'text-foreground/95'
                  }`}
                >
                  <Markdown
                    content={cleanedSummary}
                    variant="full"
                    allowHtml={false}
                    onOpenLink={openLink}
                  />
                </div>
              ) : (
                <div className="py-3 text-sm text-foreground-passive">Metin yanıtı dönmedi.</div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body
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
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
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
  const expandedIndex = expandedKey
    ? sortedAgents.findIndex((a) => agentKey(a) === expandedKey)
    : -1;

  const runningAgents = sortedAgents.filter((agent) => agent.status === 'running');
  const finishedAgents = sortedAgents.filter((agent) => agent.status !== 'running');

  const modalPortal =
    expandedIndex >= 0 ? (
      <SubagentExpandedModal
        agents={sortedAgents}
        selectedIndex={expandedIndex}
        now={now}
        onSelectIndex={(idx) => {
          const target = sortedAgents[idx];
          if (!target) return;
          const nextKey = agentKey(target);
          setExpandedKey(nextKey);
          if (selectedKey) setSelectedKey(nextKey);
        }}
        onClose={() => setExpandedKey(null)}
        onCancelSubagent={onCancelSubagent}
      />
    ) : null;

  // Seçili bir ajan varsa tam panel detay görünümünü aç (drill-down)
  if (selectedAgent) {
    const key = agentKey(selectedAgent);
    return (
      <>
        <SubagentDetailView
          agent={selectedAgent}
          now={now}
          onBack={() => setSelectedKey(null)}
          onExpand={() => setExpandedKey(key)}
          onCancelSubagent={onCancelSubagent}
        />
        {modalPortal}
      </>
    );
  }

  // 'live' modunda yalnızca şu an çalışan alt ajanlar Görev Ayrıntıları kartıyla uyumlu
  // tek, sade bir kart içinde görünür; işleri bitince bu alan kendiliğinden kaybolur.
  if (mode === 'live') {
    if (runningAgents.length === 0) return modalPortal;
    return (
      <>
        <div className="mt-2.5 flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background-1">
          <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2">
            <span className="flex items-center gap-2 text-[11px] font-medium text-foreground-muted">
              <span className="size-1.5 rounded-full bg-sky-400" />
              <span>Çalışan alt ajanlar</span>
            </span>
            <span className="font-mono text-[11px] tabular-nums text-foreground-passive">
              {runningAgents.length}
            </span>
          </div>
          <div className="flex-1 divide-y divide-border/60 overflow-y-auto">
            {runningAgents.map((agent) => {
              const key = agentKey(agent);
              return (
                <LiveSubagentRow
                  key={key}
                  agent={agent}
                  now={now}
                  onSelect={() => setSelectedKey(key)}
                  onExpand={() => setExpandedKey(key)}
                  onCancelSubagent={onCancelSubagent}
                />
              );
            })}
          </div>
        </div>
        {modalPortal}
      </>
    );
  }

  // Geçmiş inceleme görünümü ('history' veya 'all')
  const successCount = finishedAgents.filter((a) => a.status === 'completed' && !a.interrupted).length;
  const failCount = finishedAgents.filter((a) => a.status === 'failed' && !a.interrupted).length;
  const MAX_VISIBLE = 6;
  const listToRender = showAllFinished ? sortedAgents : sortedAgents.slice(0, MAX_VISIBLE);
  const hiddenCount = sortedAgents.length - listToRender.length;

  return (
    <>
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
              <div
                key={key}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedKey(key)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedKey(key);
                  }
                }}
                className="group/item flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05] outline-none"
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
                      className={`truncate text-[12px] font-medium ${
                        isFailed
                          ? 'text-rose-300'
                          : 'text-foreground/90 group-hover/item:text-foreground'
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
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedKey(key);
                    }}
                    title="Büyük pencerede aç"
                    aria-label="Büyük pencerede aç"
                    className="flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground-passive opacity-0 transition-all group-hover/item:opacity-100 hover:bg-white/[0.09] hover:text-foreground focus:opacity-100"
                  >
                    <Maximize2 className="size-3" />
                  </button>
                  {showElapsed && <span className="font-mono tabular-nums">{elapsed}</span>}
                  <ChevronRight className="size-3.5 opacity-40 transition-transform group-hover/item:translate-x-0.5 group-hover/item:opacity-80" />
                </div>
              </div>
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
      {modalPortal}
    </>
  );
}
