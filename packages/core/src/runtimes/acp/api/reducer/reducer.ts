/**
 * Pure parser state reducer.
 *
 * State is now composite — it holds the transcript slice (committed turns +
 * active turn) and the session slices (config, usage, title) side by side.
 * A single reduce() call routes each NormalizedEvent to the appropriate slice:
 *
 *   content and new foreground calls → turn/segment boundaries + item fold.
 *   async tool/plan updates → their owner, without foreground side effects.
 *
 *   session kinds (config / mode_selected / commands / usage / title)
 *     → slice update, no turn boundary side-effect.
 *
 *   ignored → no-op on all slices.
 *
 *   turn_end / replay_end → finalize + commit the active transcript turn.
 *
 * Turn boundary rules (transcript only):
 *   OPEN (implicit):  a new user message (new item id) → close active + open.
 *   OPEN (lazy):      agent content with no active turn → open.
 *   CLOSE (explicit): 'turn_end' / 'replay_end' input → closeActive.
 *   CLOSE (implicit): next new user message while a turn is active → closeActive + open.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentState, AgentStatus } from '../models/agents';
import type { SessionCommand, SessionConfigState, SessionUsage } from '../models/config';
import { initialSessionConfigState } from '../models/config';
import { SESSION_PLAN_ID, type PlanState } from '../models/plan';
import type {
  TranscriptItem,
  ToolNode,
  TranscriptTurnInitiator,
  TranscriptTurnOutcome,
  TranscriptTurn,
} from '../models/turns';
import { deriveConfigGroups } from './config-derive';
import {
  closeContent,
  initialSegment,
  materializeContent,
  type SegmentState,
} from './content-stream';
import { decodeSessionUpdate } from './decode';
import { routeEvent, type ToolEvent, type ToolOwner } from './event-routing';
import { makeMessageId, makeTurnId } from './ids';
import { foldItem, finalizeItems, type FoldEvent } from './item-fold';
import type { EnrichHook, NormalizedEvent } from './normalized-event';

// The invariant check below reads NODE_ENV, which bundlers statically replace
// in browser builds; the structural declaration keeps this isomorphic reducer
// free of node ambient types.
declare const process: { env: { NODE_ENV?: string } };

export interface TranscriptSlice {
  committed: TranscriptTurn[];
  active: TranscriptTurn | null;
}

export interface ParserState {
  transcript: TranscriptSlice;
  config: SessionConfigState;
  usage: SessionUsage | null;
  title: string | null;
  pendingModeId: string | null;
  segment: SegmentState;
  agents: AgentState[];
  plan: PlanState | null;
  toolOwners: ReadonlyMap<string, ToolOwner>;
  pendingTools: readonly ToolEvent[];
  planTurnId: string | null;
  historyRevision: number;
}

export type ReducerInput =
  | { kind: 'update'; update: SessionUpdate; at: number }
  | { kind: 'event'; event: NormalizedEvent; at: number }
  | { kind: 'replay_start'; at: number }
  | { kind: 'replay_end'; at: number }
  | { kind: 'turn_end'; at: number; outcome?: TranscriptTurnOutcome };

export interface ReducerDeps {
  conversationId: string;
  enrich?: EnrichHook;
}

export function initialState(): ParserState {
  return {
    transcript: { committed: [], active: null },
    config: initialSessionConfigState,
    usage: null,
    title: null,
    pendingModeId: null,
    segment: initialSegment(),
    agents: [],
    plan: null,
    toolOwners: new Map(),
    pendingTools: [],
    planTurnId: null,
    historyRevision: 0,
  };
}

function nextTurnIndex(t: TranscriptSlice): number {
  return t.committed.length + (t.active ? 1 : 0);
}

function nextTurnSeq(t: TranscriptSlice): number {
  return t.committed.at(-1)?.seq !== undefined ? t.committed.at(-1)!.seq + 1 : 0;
}

function openTurn(
  t: TranscriptSlice,
  deps: ReducerDeps,
  initiator: TranscriptTurnInitiator,
  at?: number
): TranscriptSlice {
  const id = makeTurnId(deps.conversationId, nextTurnIndex(t));
  const turn: TranscriptTurn = {
    id,
    seq: nextTurnSeq(t),
    initiator,
    items: [],
    ...(typeof at === 'number' && Number.isFinite(at) ? { startedAt: Math.trunc(at) } : {}),
  };
  return { ...t, active: turn };
}

/**
 * Finalize and commit the active turn to history.
 * No-op when there is no active turn.
 */
export function closeActive(
  t: TranscriptSlice,
  at: number,
  outcome?: TranscriptTurnOutcome
): TranscriptSlice {
  if (!t.active) return t;
  const committed: TranscriptTurn = {
    ...t.active,
    items: finalizeItems(t.active.items, at),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(typeof at === 'number' && Number.isFinite(at) ? { completedAt: Math.trunc(at) } : {}),
  };
  return { committed: [...t.committed, committed], active: null };
}

/**
 * Returns true when the incoming user message represents a NEW turn open.
 * Uses the CURRENT active turn's id — not a tentative next-turn id — so the
 * lookup matches the items already stored in the turn.
 */
export function isNewUserMessage(
  active: TranscriptTurn | null,
  event: Extract<NormalizedEvent, { kind: 'message' }>,
  segment: SegmentState
): boolean {
  if (!active) return true;
  if (event.messageId === null) {
    if (segment.open?.kind === 'user') return false;
    return active.items.some((it) => it.kind !== 'message' || it.role !== 'user');
  }
  const id = makeMessageId(active.id, event.messageId, 'user');
  return !active.items.some((it) => it.kind === 'message' && it.id === id);
}

function materializeEvent(
  turn: TranscriptTurn,
  segment: SegmentState,
  event: NormalizedEvent,
  foreground: boolean,
  at: number
): { turn: TranscriptTurn; segment: SegmentState; event: FoldEvent } {
  if (event.kind === 'message' || event.kind === 'thinking') {
    return materializeContent(turn, segment, event, at);
  }
  const content = foreground ? closeContent(turn, segment, at) : { turn, segment };
  return { ...content, event };
}

function toAgentStatus(
  status: Extract<NormalizedEvent, { kind: 'subagent' }>['status']
): AgentStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'in_progress':
    case null:
      return 'running';
  }
}

function updateAgentSlice(
  agents: AgentState[],
  event: NormalizedEvent,
  launchTurnId: string | null,
  at: number
): AgentState[] {
  if (event.kind !== 'subagent' && event.kind !== 'subagent_update') return agents;

  const idx =
    event.kind === 'subagent_update'
      ? findUpdatedAgentIndex(agents, event)
      : agents.findIndex(
          (agent) => agent.agentId === event.agentId || agent.toolCallId === event.toolCallId
        );
  const existing = idx >= 0 ? agents[idx] : undefined;
  // Güncelleme yalnızca bilinen bir ajanı değiştirir. Arka plan *komutlarının* (Bash) bitiş
  // bildirimleri de `subagent_update` olarak gelir; bunlar için kart açılmamalı — aksi halde
  // geçmiş yeniden yüklendiğinde her arka plan komutu "alt ajan" olarak listeleniyordu.
  if (event.kind === 'subagent_update' && !existing) return agents;
  // Akıbeti bilinmeyen bitiş yalnızca hâlâ çalışan bir ajanı kapatır; bilinen sonucu ezmez.
  if (event.kind === 'subagent_update' && event.statusUnknown && existing?.status !== 'running')
    return agents;
  const agentId = event.agentId ?? existing?.agentId ?? event.toolCallId;
  if (!agentId) return agents;
  // Güncellemenin araç çağrısı kimliği, ajanı başlatan çağrıdan farklı olabilir (Claude'un
  // `SendMessage` ile yeniden başlatılan ajanının bildirimi o çağrının kimliğini taşır). Ajanın
  // dökümdeki satırı başlatma çağrısıdır; kimlik ona sabit kalır.
  const toolCallId =
    event.kind === 'subagent_update'
      ? (existing?.toolCallId ?? event.toolCallId ?? agentId)
      : (event.toolCallId ?? existing?.toolCallId ?? agentId);
  const status = event.status === null && existing ? existing.status : toAgentStatus(event.status);
  const completedAt =
    status === 'completed' || status === 'failed'
      ? { completedAt: existing?.completedAt ?? at }
      : {};

  if (event.kind === 'subagent') {
    const base = idx >= 0 ? { ...agents[idx] } : {};
    if (status === 'running') delete (base as Partial<AgentState>).completedAt;
    if (event.status !== null) {
      delete (base as Partial<AgentState>).statusUnknown;
      delete (base as Partial<AgentState>).interrupted;
    }
    const next: AgentState = {
      ...base,
      agentId,
      toolCallId,
      launchTurnId: existing?.launchTurnId ?? launchTurnId,
      name: event.title || existing?.name || agentId,
      status,
      startedAt: idx >= 0 ? agents[idx].startedAt : at,
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      ...(event.background !== undefined ? { background: event.background } : {}),
      ...(event.detached ? { detached: true } : {}),
      ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
      ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
      ...(event.role !== undefined ? { role: event.role } : {}),
      ...(event.provider !== undefined ? { provider: event.provider } : {}),
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.effort !== undefined ? { effort: event.effort } : {}),
      ...(event.activities !== undefined ? { activities: event.activities } : {}),
      ...completedAt,
    };
    return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
  }

  const base =
    idx >= 0
      ? { ...agents[idx] }
      : {
          agentId,
          toolCallId,
          launchTurnId,
          name: agentId,
          startedAt: at,
        };
  if (status === 'running') delete (base as Partial<AgentState>).completedAt;
  delete (base as Partial<AgentState>).statusUnknown;
  delete (base as Partial<AgentState>).interrupted;
  const next: AgentState = {
    ...base,
    agentId,
    toolCallId,
    status,
    ...(event.statusUnknown ? { statusUnknown: true } : {}),
    ...(event.interrupted && status === 'failed' ? { interrupted: true } : {}),
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
    ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
    ...(event.role !== undefined ? { role: event.role } : {}),
    ...(event.provider !== undefined ? { provider: event.provider } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
    ...(event.effort !== undefined ? { effort: event.effort } : {}),
    ...(event.activities !== undefined ? { activities: event.activities } : {}),
    ...completedAt,
  };
  return idx >= 0 ? agents.map((agent, i) => (i === idx ? next : agent)) : [...agents, next];
}

/**
 * Bir durum güncellemesinin ait olduğu ajan. Ajan kimliği önce gelir: aynı ajanın sonraki
 * bildirimleri başka bir araç çağrısının (ör. onu yeniden başlatan `SendMessage`) kimliğini
 * taşıyabilir ve o kimlik başka bir kartla eşleşmemelidir.
 */
function findUpdatedAgentIndex(
  agents: readonly AgentState[],
  event: Extract<NormalizedEvent, { kind: 'subagent_update' }>
): number {
  if (event.agentId) {
    const byAgent = agents.findIndex((agent) => agent.agentId === event.agentId);
    if (byAgent >= 0) return byAgent;
  }
  return event.toolCallId ? agents.findIndex((agent) => agent.toolCallId === event.toolCallId) : -1;
}

function updatePlanSlice(
  plan: PlanState | null,
  event: NormalizedEvent,
  at: number
): PlanState | null {
  if (event.kind !== 'plan') return plan;
  return {
    id: SESSION_PLAN_ID,
    entries: event.entries.map((entry, index) => ({
      id: `${SESSION_PLAN_ID}:entry:${index}`,
      ...entry,
    })),
    updatedAt: at,
  };
}

function assertTurnInvariants(turn: TranscriptTurn): void {
  const ids = new Set<string>();
  const assertSortedSiblings = (items: TranscriptItem[] | ToolNode[]): void => {
    let previousSeq = -1;
    const siblingSeqs = new Set<number>();
    for (const item of items) {
      if (item.seq < previousSeq) {
        throw new Error(
          'AcpTranscriptParser invariant failed: sibling items are not sorted by seq'
        );
      }
      previousSeq = item.seq;
      if (siblingSeqs.has(item.seq)) {
        throw new Error(
          `AcpTranscriptParser invariant failed: duplicate sibling seq '${item.seq}'`
        );
      }
      siblingSeqs.add(item.seq);
    }
  };
  const visit = (item: TranscriptItem | ToolNode): void => {
    if (ids.has(item.id)) {
      throw new Error(`AcpTranscriptParser invariant failed: duplicate item id '${item.id}'`);
    }
    ids.add(item.id);
    if ('children' in item && item.children?.length) {
      assertSortedSiblings(item.children);
      for (const child of item.children) visit(child);
    }
  };

  let openThinking = 0;
  assertSortedSiblings(turn.items);
  for (const item of turn.items) {
    visit(item);
    if (item.kind === 'thinking' && item.status === 'thinking') openThinking += 1;
  }
  if (openThinking > 1) {
    throw new Error('AcpTranscriptParser invariant failed: multiple open thinking rows');
  }
}

function assertTranscriptInvariants(transcript: TranscriptSlice): void {
  if (process.env.NODE_ENV === 'production') return;
  let previousTurnSeq = -1;
  for (const turn of transcript.committed) {
    if (turn.seq <= previousTurnSeq) {
      throw new Error(
        'AcpTranscriptParser invariant failed: committed turns are not sorted by seq'
      );
    }
    previousTurnSeq = turn.seq;
  }
  if (transcript.active && transcript.active.seq <= previousTurnSeq) {
    throw new Error('AcpTranscriptParser invariant failed: active turn seq is not after history');
  }
  for (const turn of transcript.committed) assertTurnInvariants(turn);
  if (transcript.active) assertTurnInvariants(transcript.active);
}

/**
 * Bitmiş bir alt ajan yeniden başlatıldı (Claude `SendMessage` → `resumedAgentId`): ajan ve
 * dökümdeki başlatma satırı, yeni bitiş bildirimi gelene kadar yeniden "çalışıyor" olur.
 * Hâlâ çalışan ajana gönderilen mesaj (kuyruğa alınan) yeniden başlatma değildir.
 */
function resumeAgent(s: ParserState, agentId: string, at: number, deps: ReducerDeps): ParserState {
  const agent = s.agents.find((candidate) => candidate.agentId === agentId);
  if (!agent || agent.status === 'running') return s;
  return reduceInput(
    s,
    { kind: 'event', at, event: { kind: 'subagent_update', agentId, status: 'in_progress' } },
    deps
  );
}

const SUBAGENT_PROMPT_PREVIEW_CHARS = 140;

function subagentPromptPreview(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, SUBAGENT_PROMPT_PREVIEW_CHARS);
}

/**
 * Beklenen alt ajanları satıra yazar: başlığa sayı, özete adlar. Kimlik verilmemişse (Codex çoklu
 * ajan v2 `wait_agent` hedef bildirmez) o an çalışan kopuk ajanlar beklenir.
 */
function withAwaitedAgents(
  event: Extract<NormalizedEvent, { kind: 'tool_call' }>,
  agents: readonly AgentState[],
  agentIds: readonly string[]
): Extract<NormalizedEvent, { kind: 'tool_call' }> {
  const awaited =
    agentIds.length > 0
      ? agents.filter((agent) => agentIds.includes(agent.agentId))
      : agents.filter((agent) => agent.detached === true && agent.status === 'running');
  if (awaited.length === 0) return event;
  return {
    ...event,
    title: `${event.title} (${awaited.length})`,
    ...(event.inputSummary === undefined
      ? { inputSummary: awaited.map((agent) => agent.name).join(', ') }
      : {}),
  };
}

/**
 * Alt ajan durumu taşıyan araç satırı (Codex `wait`, `interrupt_agent`, …): önce satırın kendisi
 * işlenir, ardından bildirdiği her ajan durumu o ajanın kartına ve başlatma satırına uygulanır.
 */
function reduceSubagentToolEvent(
  s: ParserState,
  event: Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>,
  at: number,
  deps: ReducerDeps
): ParserState {
  const { subagentUpdates, awaitsSubagents, ...toolEvent } = event;
  const rowEvent: NormalizedEvent =
    toolEvent.kind === 'tool_call' && awaitsSubagents !== undefined
      ? withAwaitedAgents(toolEvent, s.agents, awaitsSubagents)
      : toolEvent;
  let next = reduceInput(s, { kind: 'event', event: rowEvent, at }, deps);
  for (const patch of subagentUpdates ?? []) {
    const agent = next.agents.find((candidate) => candidate.agentId === patch.agentId);
    if (!agent) continue;
    if (patch.ifRunning && agent.status !== 'running') continue;
    next = reduceInput(
      next,
      {
        kind: 'event',
        at,
        event: {
          kind: 'subagent_update',
          agentId: patch.agentId,
          status: patch.status,
          ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
          ...(patch.interrupted ? { interrupted: true as const } : {}),
        },
      },
      deps
    );
  }
  return next;
}

/**
 * Pure reducer: (ParserState, ReducerInput, ReducerDeps) → ParserState.
 * All state changes return a new ParserState; no mutation occurs.
 */
export function reduce(s: ParserState, input: ReducerInput, deps: ReducerDeps): ParserState {
  const next = reduceInput(s, input, deps);
  if (input.kind === 'replay_start') return next;
  return next.transcript.committed === s.transcript.committed
    ? next
    : { ...next, historyRevision: s.historyRevision + 1 };
}

function reduceInput(s: ParserState, input: ReducerInput, deps: ReducerDeps): ParserState {
  if (input.kind === 'replay_start') {
    return initialState();
  }

  if (input.kind === 'replay_end') {
    const transcript = closeActive(s.transcript, input.at);
    return transcript === s.transcript
      ? { ...s, segment: initialSegment() }
      : { ...s, transcript, segment: initialSegment() };
  }

  if (input.kind === 'turn_end') {
    const transcript = closeActive(s.transcript, input.at, input.outcome);
    return transcript === s.transcript
      ? { ...s, segment: initialSegment() }
      : { ...s, transcript, segment: initialSegment() };
  }

  const event =
    input.kind === 'event'
      ? input.event
      : deps.enrich
        ? deps.enrich(decodeSessionUpdate(input.update), input.update)
        : decodeSessionUpdate(input.update);

  if (
    (event.kind === 'tool_call' || event.kind === 'tool_update') &&
    (event.subagentUpdates !== undefined || event.awaitsSubagents !== undefined)
  ) {
    return reduceSubagentToolEvent(s, event, input.at, deps);
  }

  if (event.kind === 'tool_update' && event.resumesAgentId) {
    const { resumesAgentId, ...toolUpdate } = event;
    return resumeAgent(
      reduceInput(s, { kind: 'event', event: toolUpdate, at: input.at }, deps),
      resumesAgentId,
      input.at,
      deps
    );
  }

  switch (event.kind) {
    case 'config': {
      const groups = deriveConfigGroups(event.options);
      const config: SessionConfigState = { ...s.config, ...groups };
      if (s.pendingModeId && config.modeOptions) {
        config.modeOptions = { ...config.modeOptions, selected: s.pendingModeId };
      }
      return {
        ...s,
        config,
        pendingModeId: config.modeOptions ? null : s.pendingModeId,
      };
    }
    case 'mode_selected': {
      if (!s.config.modeOptions) return { ...s, pendingModeId: event.modeId };
      const config: SessionConfigState = {
        ...s.config,
        modeOptions: { ...s.config.modeOptions, selected: event.modeId },
      };
      return { ...s, config, pendingModeId: null };
    }
    case 'commands': {
      const availableCommands = event.commands.map((c) => {
        const raw = c as unknown as {
          name: string;
          description: string;
          input?: { hint?: string };
        };
        const cmd: SessionCommand = {
          name: raw.name,
          description: raw.description,
          source: 'provider-command',
        };
        if (raw.input?.hint) cmd.inputHint = raw.input.hint;
        return cmd;
      });
      return { ...s, config: { ...s.config, availableCommands } };
    }
    case 'usage':
      return { ...s, usage: event.usage };
    case 'title':
      return { ...s, title: event.title };
    case 'mcp_startup_failure':
    case 'ignored':
      return s;
    case 'subagent_update': {
      const agents = updateAgentSlice(s.agents, event, s.transcript.active?.id ?? null, input.at);
      // Akıbeti bilinmeyen bitiş, zaten sonuçlanmış bir ajana dokunmaz (bkz. updateAgentSlice).
      if (event.statusUnknown && agents === s.agents) return s;
      // Güncelleme ajanın başlatma satırına uygulanır; bildirimdeki araç çağrısı kimliği ajanı
      // yeniden başlatan `SendMessage` çağrısına ait olabilir ve o satır kendi sonucuyla kapanır.
      const index = findUpdatedAgentIndex(agents, event);
      const agent = index >= 0 ? agents[index] : undefined;
      const toolCallId = agent ? agent.toolCallId : event.toolCallId;
      if (!toolCallId || !s.toolOwners.has(toolCallId)) return { ...s, agents };
      return reduce(
        { ...s, agents },
        {
          kind: 'event',
          at: input.at,
          event: {
            kind: 'tool_update',
            toolCallId,
            parentToolCallId: null,
            ...(event.statusUnknown ? { statusUnknown: true as const } : { status: event.status }),
            // Kopuk ajanın (Codex) görevi ve yanıtı yalnızca bu bildirimlerle gelir; satır akışta
            // ("Akış") görev ve yanıt olarak gösterebilsin.
            ...(agent?.detached && event.prompt
              ? { inputSummary: subagentPromptPreview(event.prompt) }
              : {}),
            ...(agent?.detached && event.summary ? { outputText: event.summary } : {}),
          },
        },
        deps
      );
    }
    default:
      break; // falls through to transcript handling below
  }

  let t = s.transcript;
  let segment = s.segment;
  const plan = updatePlanSlice(s.plan, event, input.at);

  // OPEN boundary: a new user message starts a new turn.
  if (event.kind === 'message' && event.role === 'user') {
    if (isNewUserMessage(t.active, event, segment)) {
      t = closeActive(t, input.at);
      t = openTurn(t, deps, 'user', input.at);
      segment = initialSegment();
    }
  }

  const route = routeEvent(event, s.toolOwners, t.active?.id ?? null, s.planTurnId);
  // Only foreground content or a new root invocation can open an agent turn.
  if (route.turnId === null && route.foreground) {
    t = openTurn(t, deps, 'agent', input.at);
    segment = initialSegment();
  }
  const turnId = route.turnId ?? (route.foreground ? t.active?.id : null);
  const routedEvent = route.tool ?? event;
  if (!turnId) {
    // Keep a bounded window of unmatched notifications from incomplete replay.
    // They may establish ownership when their start/parent arrives; they never
    // create a turn merely because the provider emitted a status notification.
    return {
      ...s,
      agents: updateAgentSlice(s.agents, routedEvent, null, input.at),
      plan,
      pendingTools: route.tool ? [...s.pendingTools, route.tool].slice(-128) : s.pendingTools,
    };
  }

  const isActive = t.active?.id === turnId;
  const owner = isActive ? t.active : t.committed.find((turn) => turn.id === turnId);
  if (!owner) throw new Error(`ACP event owner turn not found: ${turnId}`);
  const materialized = materializeEvent(owner, segment, routedEvent, route.foreground, input.at);
  if (isActive) segment = materialized.segment;

  let toolOwners = s.toolOwners;
  if (route.tool) {
    const previous = toolOwners.get(route.tool.toolCallId);
    if (previous?.turnId !== turnId || previous.parentToolCallId !== route.tool.parentToolCallId) {
      toolOwners = new Map(toolOwners).set(route.tool.toolCallId, {
        turnId,
        parentToolCallId: route.tool.parentToolCallId,
      });
    }
  }
  const pendingForCall = route.tool
    ? s.pendingTools.filter((pending) => pending.toolCallId === route.tool?.toolCallId)
    : [];
  let items = materialized.turn.items;
  // An update observed before its start contains newer tool state than that
  // start's initial fields. For update-only recovery, the arriving patch wins.
  const isUpdate =
    routedEvent.kind === 'tool_update' ||
    ('operation' in routedEvent && routedEvent.operation === 'update');
  const operations = isUpdate
    ? [...pendingForCall, materialized.event]
    : [materialized.event, ...pendingForCall];
  let agents = s.agents;
  for (const operation of operations) {
    items = foldItem(items, operation, turnId, input.at);
    agents = updateAgentSlice(agents, operation, turnId, input.at);
  }
  const updated = items === owner.items ? owner : { ...owner, items };
  const transcript = isActive
    ? { ...t, active: updated }
    : updated === owner
      ? t
      : { ...t, committed: t.committed.map((turn) => (turn.id === turnId ? updated : turn)) };
  let result: ParserState = {
    ...s,
    transcript,
    segment,
    agents,
    plan,
    toolOwners,
    planTurnId: event.kind === 'plan' ? turnId : s.planTurnId,
    pendingTools: pendingForCall.length
      ? s.pendingTools.filter((pending) => !pendingForCall.includes(pending))
      : s.pendingTools,
  };
  // A parent can establish ownership of previously unseen child calls. Remove
  // them before folding so each retained notification is replayed exactly once.
  const ready = result.pendingTools.filter(
    (pending) =>
      toolOwners.has(pending.toolCallId) ||
      (pending.parentToolCallId !== null && toolOwners.has(pending.parentToolCallId))
  );
  if (ready.length) {
    result = {
      ...result,
      pendingTools: result.pendingTools.filter((pending) => !ready.includes(pending)),
    };
    for (const pending of ready)
      result = reduce(result, { kind: 'event', event: pending, at: input.at }, deps);
  }
  assertTranscriptInvariants(result.transcript);
  return result;
}
