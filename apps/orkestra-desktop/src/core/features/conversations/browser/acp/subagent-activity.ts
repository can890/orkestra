import type { SubagentPhase, ToolNode, TranscriptTurn } from '@orkestra/chat-ui';
import type { OrchestraWorkerSummary } from '@core/features/orchestra/api/orchestra';
import type { AgentStatus } from '@core/primitives/agents/api';

type TranscriptItem = TranscriptTurn['items'][number];

/** Yan panelde gösterilen hafif etkinlik akışı öğesi. */
export type SubagentFeedEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'thinking'; id: string; active: boolean }
  | {
      kind: 'tool';
      id: string;
      title: string;
      detail?: string;
      status: 'running' | 'done' | 'error';
      depth: number;
    };

/**
 * Orkestra şefinin işçi başlatma çağrısı (Claude Code: `mcp__orkestra__spawn_agent`, Codex:
 * `mcp.orkestra.spawn_agent`).
 */
export type OrchestraSpawnRef = {
  itemId: string;
  toolCallId: string;
  inputSummary?: string;
  status: 'running' | 'done' | 'error';
};

/** Yerel alt ajan çağrısı (ör. Claude Code'un Agent aracı). */
export type NativeSubagentRef = {
  itemId: string;
  toolCallId: string;
  name: string;
  phase: SubagentPhase;
};

const ORCHESTRA_MCP_SERVER = 'orkestra';
const ORCHESTRA_SPAWN_TOOL = 'spawn_agent';

/** İsteğe bağlı `mcp` öneki, `orkestra` sunucusu ve araç; `__`, `.` veya `:` ile ayrılır. */
const ORCHESTRA_TOOL_NAME = /^(?:mcp(?:__|\.|:))?orkestra(?:__|\.|:)(\w+)$/;

/**
 * Sağlayıcının araç adından Orkestra MCP aracının çıplak adını (`spawn_agent`) çıkarır. Her
 * sağlayıcı MCP aracını farklı yazar: Claude Code `mcp__orkestra__spawn_agent`, Codex
 * `mcp.orkestra.spawn_agent`; `orkestra__`, `orkestra.` ve `orkestra:` biçimleri de kabul edilir.
 * chat-ui'daki `orchestra-tool.ts` ile aynı kuralı izler; ikisi birlikte değişmelidir.
 */
export function orchestraToolName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  return ORCHESTRA_TOOL_NAME.exec(name.trim())?.[1];
}

export function isOrchestraSpawnName(name: string): boolean {
  return orchestraToolName(name) === ORCHESTRA_SPAWN_TOOL;
}

/**
 * Düğümün çağırdığı Orkestra aracı; araç türüne bakılmaz, çünkü Claude Code MCP çağrılarını
 * `unknown-tool-call`, Codex ise `execute-tool-call` olarak bildirir. Gruplar ve sağlayıcının
 * kendi alt ajanları Orkestra çağrısı değildir.
 */
export function orchestraToolOf(node: ToolNode): string | undefined {
  switch (node.kind) {
    case 'tool-group':
    case 'spawn-subagent-tool-call':
      return undefined;
    case 'mcp-tool-call': {
      if (node.server === undefined) {
        return orchestraToolName(node.tool) ?? orchestraToolName(node.title);
      }
      if (node.server !== ORCHESTRA_MCP_SERVER) return undefined;
      const tool = node.tool.trim();
      return orchestraToolName(tool) ?? (/^\w+$/.test(tool) ? tool : undefined);
    }
    case 'unknown-tool-call':
      return orchestraToolName(node.name) ?? orchestraToolName(node.title);
    default:
      return orchestraToolName(node.title);
  }
}

/**
 * Şefin işçi başlatma çağrısı mı (`spawn_agent`), sağlayıcıdan bağımsız. Tür koruyucu değil, düz
 * boolean döner: koruyucu olsaydı olumsuz dal `tool-group` türüne daralırdı.
 */
export function isOrchestraSpawnNode(node: ToolNode): boolean {
  return orchestraToolOf(node) === ORCHESTRA_SPAWN_TOOL;
}

export function transcriptTurns(state: {
  readonly displayTurns: readonly TranscriptTurn[];
  readonly activeTurnSnapshot?: TranscriptTurn | null;
}): TranscriptTurn[] {
  return state.activeTurnSnapshot
    ? [...state.displayTurns, state.activeTurnSnapshot]
    : [...state.displayTurns];
}

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind !== 'message' && item.kind !== 'thinking';
}

function childrenOf(node: ToolNode): readonly ToolNode[] {
  return 'children' in node && node.children ? node.children : [];
}

function walkTools(nodes: readonly ToolNode[], visit: (node: ToolNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkTools(childrenOf(node), visit);
  }
}

function walkTurnTools(turns: readonly TranscriptTurn[], visit: (node: ToolNode) => void): void {
  for (const turn of turns) {
    walkTools(turn.items.filter(isToolNode), visit);
  }
}

export function findToolNode(
  turns: readonly TranscriptTurn[],
  toolCallId: string
): ToolNode | null {
  let found: ToolNode | null = null;
  walkTurnTools(turns, (node) => {
    if (!found && 'toolCallId' in node && node.toolCallId === toolCallId) found = node;
  });
  return found;
}

export function collectOrchestraSpawns(turns: readonly TranscriptTurn[]): OrchestraSpawnRef[] {
  const spawns: OrchestraSpawnRef[] = [];
  walkTurnTools(turns, (node) => {
    if (node.kind === 'tool-group' || !isOrchestraSpawnNode(node)) return;
    spawns.push({
      itemId: node.id,
      toolCallId: node.toolCallId,
      ...(node.inputSummary ? { inputSummary: node.inputSummary.trim() } : {}),
      status: node.status,
    });
  });
  return spawns;
}

export function nativeSubagentPhase(node: {
  status: string;
  agentId?: string;
  background?: boolean;
}): SubagentPhase {
  if (node.status === 'done') return 'completed';
  if (node.status === 'error') return 'failed';
  // Ön plandaki alt ajanlar hiç agentId almaz; yalnızca arka plan ajanları başlatılırken bekler.
  return node.background && !node.agentId ? 'spawning' : 'running';
}

/** Sağlayıcının genel "Agent" etiketini, varsa açıklama satırıyla değiştirir. */
export function nativeSubagentName(node: {
  name?: string;
  inputSummary?: string;
  title?: string;
}): string {
  const candidates = [node.name, node.inputSummary, node.title];
  return candidates.find((value) => value && value.trim() && value !== 'Agent') ?? 'Alt ajan';
}

export function collectNativeSubagents(turns: readonly TranscriptTurn[]): NativeSubagentRef[] {
  const subagents: NativeSubagentRef[] = [];
  walkTurnTools(turns, (node) => {
    if (node.kind !== 'spawn-subagent-tool-call') return;
    subagents.push({
      itemId: node.id,
      toolCallId: node.toolCallId,
      name: nativeSubagentName(node),
      phase: nativeSubagentPhase(node),
    });
  });
  return subagents;
}

function toolDetail(node: ToolNode): string | undefined {
  switch (node.kind) {
    case 'execute-tool-call':
      return node.command ?? node.inputSummary;
    case 'read-tool-call':
      return node.locations?.[0]?.path ?? node.inputSummary;
    case 'create-file-tool-call':
    case 'modify-file-tool-call':
    case 'delete-file-tool-call':
      return node.path;
    case 'search-tool-call':
      return node.query;
    case 'mcp-tool-call':
      return [node.server, node.tool].filter(Boolean).join('.');
    case 'web-fetch-tool-call':
      return node.pageTitle ?? node.url;
    case 'spawn-subagent-tool-call':
      return node.name;
    case 'tool-group':
      return undefined;
    default:
      return 'inputSummary' in node ? node.inputSummary : undefined;
  }
}

/** Araç ağacını girintili satırlara açar. */
export function toolFeedEntries(nodes: readonly ToolNode[], depth = 0): SubagentFeedEntry[] {
  const entries: SubagentFeedEntry[] = [];
  for (const node of nodes) {
    const title = node.kind === 'tool-group' ? node.label : node.title;
    const detail = toolDetail(node);
    entries.push({
      kind: 'tool',
      id: node.id,
      title: title || node.kind,
      ...(detail && detail !== title ? { detail } : {}),
      status: node.status,
      depth,
    });
    entries.push(...toolFeedEntries(childrenOf(node), depth + 1));
  }
  return entries;
}

/** Bir sohbetin tamamını akışa çevirir; yalnızca son düşünme bloğu "düşünüyor" olarak kalır. */
export function transcriptFeed(turns: readonly TranscriptTurn[]): SubagentFeedEntry[] {
  const entries: SubagentFeedEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'message') {
        if (item.text.trim()) {
          entries.push({ kind: 'message', id: item.id, role: item.role, text: item.text });
        }
      } else if (item.kind === 'thinking') {
        entries.push({ kind: 'thinking', id: item.id, active: item.status === 'thinking' });
      } else {
        entries.push(...toolFeedEntries([item]));
      }
    }
  }
  // Eski düşünme blokları gürültü yapar; yalnızca hâlâ süren düşünmeyi göster.
  return entries.filter((entry) => entry.kind !== 'thinking' || entry.active);
}

/**
 * Şefin işçi başlatma çağrılarını işçilerle eşler. MCP çıktısı dökümde saklanmadığı için önce
 * şefin yazdığı açıklama satırı, kalanlar için başlatma sırası kullanılır. Hata veren çağrılar
 * işçi oluşturmadığından eşlenmez.
 */
export function matchOrchestraWorkers(
  spawns: readonly OrchestraSpawnRef[],
  workers: readonly OrchestraWorkerSummary[]
): Map<string, OrchestraWorkerSummary> {
  const links = new Map<string, OrchestraWorkerSummary>();
  const remaining = [...workers].sort((left, right) => left.createdAt - right.createdAt);
  const take = (worker: OrchestraWorkerSummary) => {
    remaining.splice(remaining.indexOf(worker), 1);
  };
  const candidates = spawns.filter((spawn) => spawn.status !== 'error');
  for (const spawn of candidates) {
    if (!spawn.inputSummary) continue;
    const worker = remaining.find((candidate) => candidate.description === spawn.inputSummary);
    if (worker) {
      links.set(spawn.toolCallId, worker);
      take(worker);
    }
  }
  for (const spawn of candidates) {
    if (links.has(spawn.toolCallId)) continue;
    const worker = remaining[0];
    if (!worker) break;
    links.set(spawn.toolCallId, worker);
    take(worker);
  }
  return links;
}

/** İşçi konuşmasının ajan durumunu alt ajan fazına çevirir. */
export function phaseFromAgentStatus(status: AgentStatus | undefined): SubagentPhase | undefined {
  switch (status) {
    case 'working':
    case 'awaiting-input':
      return 'running';
    case 'error':
      return 'failed';
    case 'completed':
    case 'idle':
      return 'completed';
    default:
      return undefined;
  }
}

/** Şemadaki bir düğüm: ana ajan, yerel alt ajan veya Orkestra işçisi. */
export type AgentGraphNode = {
  id: string;
  kind: 'root' | 'subagent' | 'orchestra-worker';
  label: string;
  detail?: string;
  phase: SubagentPhase;
  /** Alt ajanın kendi araç adımı sayısı (iç içe alt ajanların adımları hariç). */
  steps: number;
  /** Şu an çalışan adımın başlığı. */
  currentStep?: string;
  toolCallId?: string;
  children: AgentGraphNode[];
};

/** Orkestra işçisi için şemaya eklenen bilgiler. */
export type AgentGraphWorker = {
  label?: string;
  detail?: string;
  phase?: SubagentPhase;
  /** Çalışan işçinin kendi sohbetinden okunan adım sayısı ve süren adım. */
  steps?: number;
  currentStep?: string;
};

function stepTitle(node: ToolNode): string {
  const title = node.kind === 'tool-group' ? node.label : node.title;
  const detail = toolDetail(node);
  return detail && detail !== title ? `${title} · ${detail}` : title || node.kind;
}

/** Alt ajanın adımlarını sayar ve süren son adımı bulur; iç içe alt ajanlara inmez. */
function summarizeSteps(nodes: readonly ToolNode[]): { steps: number; currentStep?: string } {
  let steps = 0;
  let currentStep: string | undefined;
  const visit = (list: readonly ToolNode[]) => {
    for (const node of list) {
      if (node.kind === 'spawn-subagent-tool-call') continue;
      if (node.kind !== 'tool-group') {
        steps += 1;
        if (node.status === 'running') currentStep = stepTitle(node);
      }
      visit(childrenOf(node));
    }
  };
  visit(nodes);
  return { steps, ...(currentStep ? { currentStep } : {}) };
}

function collectGraphChildren(
  nodes: readonly ToolNode[],
  workers: ReadonlyMap<string, AgentGraphWorker>
): AgentGraphNode[] {
  const result: AgentGraphNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'spawn-subagent-tool-call') {
      const children = childrenOf(node);
      result.push({
        id: node.toolCallId,
        kind: 'subagent',
        label: nativeSubagentName(node),
        phase: nativeSubagentPhase(node),
        toolCallId: node.toolCallId,
        ...summarizeSteps(children),
        children: collectGraphChildren(children, workers),
      });
      continue;
    }
    if (node.kind !== 'tool-group' && isOrchestraSpawnNode(node)) {
      const worker = workers.get(node.toolCallId);
      const fallbackPhase: SubagentPhase =
        node.status === 'error' ? 'failed' : node.status === 'done' ? 'running' : 'spawning';
      result.push({
        id: node.toolCallId,
        kind: 'orchestra-worker',
        label: worker?.label ?? node.inputSummary?.trim() ?? 'Orkestra işçisi',
        ...(worker?.detail ? { detail: worker.detail } : {}),
        phase: node.status === 'error' ? 'failed' : (worker?.phase ?? fallbackPhase),
        toolCallId: node.toolCallId,
        steps: worker?.steps ?? 0,
        ...(worker?.currentStep ? { currentStep: worker.currentStep } : {}),
        children: [],
      });
      continue;
    }
    result.push(...collectGraphChildren(childrenOf(node), workers));
  }
  return result;
}

/**
 * Sohbetteki alt ajan hiyerarşisini şema ağacına çevirir. Kök, sohbetin ana ajanıdır; altında
 * yerel alt ajanlar (iç içe olabilir) ve Orkestra işçileri başlatılma sırasıyla yer alır.
 */
export function buildAgentGraph(
  turns: readonly TranscriptTurn[],
  root: { label: string; detail?: string; phase: SubagentPhase },
  workers: ReadonlyMap<string, AgentGraphWorker> = new Map()
): AgentGraphNode {
  const children: AgentGraphNode[] = [];
  for (const turn of turns) {
    children.push(...collectGraphChildren(turn.items.filter(isToolNode), workers));
  }
  return {
    id: 'root',
    kind: 'root',
    label: root.label,
    ...(root.detail ? { detail: root.detail } : {}),
    phase: root.phase,
    steps: 0,
    children,
  };
}

/** Şema özetindeki sayılar (kök hariç). */
export function countGraphPhases(node: AgentGraphNode): Record<SubagentPhase, number> {
  const counts: Record<SubagentPhase, number> = {
    spawning: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  const visit = (current: AgentGraphNode) => {
    for (const child of current.children) {
      counts[child.phase] += 1;
      visit(child);
    }
  };
  visit(node);
  return counts;
}

/** Bir işçi sohbetinin tamamındaki araç adımlarını sayar ve süren son adımı bulur. */
export function summarizeTranscriptSteps(turns: readonly TranscriptTurn[]): {
  steps: number;
  currentStep?: string;
} {
  return summarizeSteps(turns.flatMap((turn) => turn.items.filter(isToolNode)));
}
