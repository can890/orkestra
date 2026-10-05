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

/** Orkestra şefinin işçi başlatma çağrısı (`mcp__orkestra__spawn_agent`). */
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

export function isOrchestraSpawnName(name: string): boolean {
  return /^(?:mcp__)?orkestra(?:__|\.|:)spawn_agent$/.test(name);
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
    if (node.kind !== 'unknown-tool-call' || !isOrchestraSpawnName(node.name)) return;
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
