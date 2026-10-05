import type { SubagentPhase } from '@orkestra/chat-ui';
import { Bot, Network, Workflow } from 'lucide-react';
import { useId, useMemo } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import { countGraphPhases, type AgentGraphNode } from './subagent-activity';

const PAD_X = 12;
const PAD_TOP = 12;
const INDENT = 22;
const GAP_Y = 12;
const TRUNK_X = 13;
const BASE_H = 38;
const LINE_H = 16;

type PlacedNode = {
  node: AgentGraphNode;
  depth: number;
  x: number;
  y: number;
  height: number;
  parent: PlacedNode | null;
  /** Aynı ebeveynin bir önceki çocuğu; gövde çizgisi oradan devam eder. */
  previousSibling: PlacedNode | null;
};

const PHASE_LABEL: Record<SubagentPhase, string> = {
  spawning: 'Başlatılıyor',
  running: 'Çalışıyor',
  completed: 'Tamamlandı',
  failed: 'Başarısız',
};

const PHASE_CARD: Record<SubagentPhase, string> = {
  spawning: 'border-border-warning bg-background-warning/30',
  running: 'border-border-info bg-background-info/30',
  completed: 'border-border-success',
  failed: 'border-border-destructive',
};

const PHASE_TEXT: Record<SubagentPhase, string> = {
  spawning: 'text-foreground-warning',
  running: 'text-foreground-info',
  completed: 'text-foreground-success',
  failed: 'text-foreground-destructive',
};

function nodeHeight(node: AgentGraphNode): number {
  const showStep = node.phase === 'running' && Boolean(node.currentStep);
  return BASE_H + (node.detail ? LINE_H : 0) + (showStep ? LINE_H : 0);
}

/** Ağacı ön-sıralı dolaşıp her düğüme konum verir: derinlik girintiye, sıra satıra dönüşür. */
export function layoutAgentGraph(root: AgentGraphNode): { nodes: PlacedNode[]; height: number } {
  const nodes: PlacedNode[] = [];
  let y = PAD_TOP;
  const place = (
    node: AgentGraphNode,
    depth: number,
    parent: PlacedNode | null,
    previousSibling: PlacedNode | null
  ): PlacedNode => {
    const placed: PlacedNode = {
      node,
      depth,
      x: PAD_X + depth * INDENT,
      y,
      height: nodeHeight(node),
      parent,
      previousSibling,
    };
    nodes.push(placed);
    y += placed.height + GAP_Y;
    let previous: PlacedNode | null = null;
    for (const child of node.children) previous = place(child, depth + 1, placed, previous);
    return placed;
  };
  place(root, 0, null, null);
  return { nodes, height: y + PAD_TOP - GAP_Y };
}

function NodeIcon({ node }: { node: AgentGraphNode }) {
  const className = cn('size-3.5 shrink-0', PHASE_TEXT[node.phase]);
  if (node.kind === 'root') return <Workflow className={className} />;
  if (node.kind === 'orchestra-worker') return <Network className={className} />;
  return <Bot className={className} />;
}

function elbowY(placed: PlacedNode): number {
  return placed.y + Math.min(19, placed.height / 2);
}

/**
 * Ebeveynin gövdesinden çocuğa giden dirsek. Gövde, bir önceki kardeşin dirseğinden devam eder;
 * böylece çizgiler üst üste binmez ve her parça altındaki çocuğun durum rengini alır.
 */
function Connector({ child, markerId }: { child: PlacedNode; markerId: string }) {
  const parent = child.parent;
  if (!parent) return null;
  const trunkX = parent.x + TRUNK_X;
  const startY = child.previousSibling ? elbowY(child.previousSibling) : parent.y + parent.height;
  const midY = elbowY(child);
  const endX = child.x - 1;
  const active = child.node.phase === 'running' || child.node.phase === 'spawning';
  return (
    <path
      d={`M ${trunkX} ${startY} V ${midY - 6} Q ${trunkX} ${midY} ${trunkX + 6} ${midY} H ${endX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeDasharray={active ? '5 4' : undefined}
      markerEnd={`url(#${markerId})`}
      className={active ? PHASE_TEXT[child.node.phase] : 'text-foreground-passive'}
    >
      {active ? (
        <animate
          attributeName="stroke-dashoffset"
          from="18"
          to="0"
          dur="0.9s"
          repeatCount="indefinite"
        />
      ) : null}
    </path>
  );
}

function NodeCard({
  placed,
  onSelect,
}: {
  placed: PlacedNode;
  onSelect?: (node: AgentGraphNode) => void;
}) {
  const { node } = placed;
  const clickable = Boolean(onSelect && node.toolCallId);
  const showStep = node.phase === 'running' && Boolean(node.currentStep);
  const stepsLabel = node.steps > 0 ? `${node.steps} adım` : null;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? () => onSelect?.(node) : undefined}
      title={clickable ? `${node.label} — akışı göster` : node.label}
      className={cn(
        'absolute flex flex-col justify-center rounded-lg border bg-(--em-surface) px-2.5 text-left shadow-xs transition-colors',
        PHASE_CARD[node.phase],
        node.kind === 'root' && 'border-2',
        clickable ? 'cursor-pointer hover:bg-background-2' : 'cursor-default'
      )}
      style={{
        left: placed.x,
        top: placed.y,
        width: `calc(100% - ${placed.x + PAD_X}px)`,
        height: placed.height,
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="relative flex size-2 shrink-0">
          {node.phase === 'running' ? (
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-60',
                'bg-foreground-info'
              )}
            />
          ) : null}
          <span
            className={cn(
              'relative inline-flex size-2 rounded-full',
              node.phase === 'running'
                ? 'bg-foreground-info'
                : node.phase === 'completed'
                  ? 'bg-foreground-success'
                  : node.phase === 'failed'
                    ? 'bg-foreground-destructive'
                    : 'bg-foreground-warning'
            )}
          />
        </span>
        <NodeIcon node={node} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{node.label}</span>
        {stepsLabel ? (
          <span className="shrink-0 rounded-full bg-background-2 px-1.5 text-[10px] text-foreground-muted">
            {stepsLabel}
          </span>
        ) : null}
      </div>
      {node.detail ? (
        <div className="truncate pl-[26px] text-[11px] text-foreground-muted">{node.detail}</div>
      ) : null}
      <div className={cn('truncate pl-[26px] text-[11px]', PHASE_TEXT[node.phase])}>
        {PHASE_LABEL[node.phase]}
      </div>
      {showStep ? (
        <div className="truncate pl-[26px] font-mono text-[10.5px] text-foreground-muted">
          ↳ {node.currentStep}
        </div>
      ) : null}
    </button>
  );
}

/**
 * Sohbetteki ajan hiyerarşisinin canlı akış şeması: kökte ana ajan, altında alt ajanlar ve
 * Orkestra işçileri. Çalışan dallarda bağlantı çizgisi akar; kutuya tıklamak akışı açar.
 */
export function AgentFlowDiagram({
  graph,
  onSelect,
}: {
  graph: AgentGraphNode;
  onSelect?: (node: AgentGraphNode) => void;
}) {
  const markerId = `agent-flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const layout = useMemo(() => layoutAgentGraph(graph), [graph]);
  const counts = useMemo(() => countGraphPhases(graph), [graph]);
  const total = counts.spawning + counts.running + counts.completed + counts.failed;
  const summary = [
    counts.running + counts.spawning > 0 ? `${counts.running + counts.spawning} çalışıyor` : null,
    counts.completed > 0 ? `${counts.completed} tamamlandı` : null,
    counts.failed > 0 ? `${counts.failed} başarısız` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-3 pt-2 text-[11px] text-foreground-muted">
        {total === 0
          ? 'Bu sohbette henüz alt ajan çalışmadı.'
          : `${total} alt ajan${summary ? ` · ${summary}` : ''}`}
      </div>
      <div className="relative w-full" style={{ height: layout.height }}>
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          aria-hidden
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
            </marker>
          </defs>
          {layout.nodes.map((placed) =>
            placed.parent ? (
              <Connector key={`edge-${placed.node.id}`} child={placed} markerId={markerId} />
            ) : null
          )}
        </svg>
        {layout.nodes.map((placed) => (
          <NodeCard key={placed.node.id} placed={placed} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
