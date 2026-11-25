import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type {
  NormalizedEvent,
  NormalizedSubagentStatusPatch,
  NormalizedToolStatus,
} from '@orkestra/core/runtimes/acp/api';

/**
 * Codex'in çoklu ajan araçlarını (`spawn_agent`, `wait_agent`, `send_message`, `interrupt_agent`,
 * `list_agents`; v1'de `spawnAgent`, `wait`, `sendInput`, …) Orkestra'nın alt ajan modeline
 * çevirir.
 *
 * codex-acp, istemci "native subagent sessions" yeteneğini bildirmediğinde (Orkestra bildirmez)
 * bu araçları düz araç satırı olarak gönderir:
 * - `subAgentActivity` öğesi → başlık `Start/Interact with/Interrupt/Complete subagent <ad>`,
 *   `rawInput: { agentThreadId, agentPath, activityKind }`, `_meta.codex.subagent`.
 * - `collabAgentToolCall` öğesi → başlık araç adı (`wait`, `spawnAgent`, …), `kind: 'other'`,
 *   `rawInput: { prompt, receiverThreadIds, agentsStates, model, reasoningEffort, status }`,
 *   `_meta.codex.collaboration`.
 * Bunlar olduğu gibi kalınca dökümde "wait other" gibi çıplak satırlar görünüyor, alt ajan paneli
 * boş kalıyordu. Başlatma satırı alt ajan kartına, diğerleri okunur Türkçe satırlara dönüşür.
 * Ajanın gerçek durumu codex-acp akışında yoktur; çekirdekteki `CodexSubagentWatcher` ajanın
 * kendi oturum kaydından okur. Burada yalnızca Codex'in kendisinin bildirdiği sonuçlar (durdurma,
 * `wait` sonucu) uygulanır.
 */

type CodexAgentState = { status?: unknown; message?: unknown };

type CollabInput = {
  prompt?: unknown;
  receiverThreadIds?: unknown;
  agentsStates?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  agentThreadId?: unknown;
  agentPath?: unknown;
  activityKind?: unknown;
};

type CodexMeta = {
  subagent?: { threadId?: unknown; path?: unknown; activity?: unknown; model?: unknown };
  collaboration?: { tool?: unknown; receiverThreadIds?: unknown };
};

const COLLAB_TOOL_TITLES: Record<string, string> = {
  spawnAgent: 'Alt ajan başlatıldı',
  wait: 'Alt ajanlar bekleniyor',
  sendInput: 'Alt ajana mesaj gönderildi',
  sendMessage: 'Alt ajana mesaj gönderildi',
  followupTask: 'Alt ajana yeni görev verildi',
  resumeAgent: 'Alt ajan sürdürüldü',
  closeAgent: 'Alt ajan kapatıldı',
  interruptAgent: 'Alt ajan durduruldu',
  listAgents: 'Alt ajanlar listelendi',
};

const ACTIVITY_TITLES: Record<string, string> = {
  interacted: 'Alt ajana mesaj gönderildi',
  interrupted: 'Alt ajan durduruldu',
  completed: 'Alt ajan tamamlandı',
};

const PREVIEW_CHARS = 140;
const SUMMARY_CHARS = 16_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

function cap(text: string): string {
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

/** codex-acp'nin `nameFromAgentPath` kuralı: `/root/mobile_app` → `Mobile app`. */
export function codexAgentName(path: string | undefined, threadId: string): string {
  const normalized = (path ?? '').trim().replace(/\/+$/, '');
  const last = normalized.slice(normalized.lastIndexOf('/') + 1).trim();
  const words = last.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words && words !== 'root') return words.charAt(0).toUpperCase() + words.slice(1);
  return `Ajan ${threadId.slice(-8)}`;
}

/** Codex ajan durumunun (`CollabAgentStatus`) karttaki karşılığı; çalışan durumlar için `null`. */
function statusPatch(
  agentId: string,
  state: CodexAgentState
): NormalizedSubagentStatusPatch | null {
  const message = nonEmpty(state.message);
  const summary = message ? { summary: cap(message) } : {};
  switch (state.status) {
    case 'completed':
      return { agentId, status: 'completed', ...summary };
    case 'errored':
      return { agentId, status: 'failed', ...summary };
    case 'notFound':
      return { agentId, status: 'failed', ...summary, ifRunning: true };
    case 'interrupted':
    case 'shutdown':
      // Bitmiş bir ajan kapatıldığında da bu durum gelir; bilinen sonucu ezmesin.
      return { agentId, status: 'failed', interrupted: true, ifRunning: true };
    default:
      return null;
  }
}

function statusPatches(agentsStates: unknown): NormalizedSubagentStatusPatch[] {
  const states = asRecord(agentsStates);
  if (!states) return [];
  return Object.entries(states).flatMap(([agentId, state]) => {
    const patch = asRecord(state) ? statusPatch(agentId, state as CodexAgentState) : null;
    return patch ? [patch] : [];
  });
}

function agentStatus(state: unknown): NormalizedToolStatus | null {
  switch (asRecord(state)?.status) {
    case 'completed':
      return 'completed';
    case 'errored':
    case 'interrupted':
    case 'shutdown':
    case 'notFound':
      return 'failed';
    case 'pendingInit':
    case 'running':
      return 'in_progress';
    default:
      return null;
  }
}

function codexMeta(raw: SessionUpdate): CodexMeta | undefined {
  const meta = asRecord((raw as { _meta?: unknown })._meta);
  return asRecord(meta?.codex) as CodexMeta | undefined;
}

/** Bir satırı okunur Türkçe başlığa çevirir; çıplak `kind` ("other") artık yazılmaz. */
function readableRow(
  event: Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>,
  title: string | null,
  extra: {
    inputSummary?: string;
    subagentUpdates?: NormalizedSubagentStatusPatch[];
    awaitsSubagents?: string[];
  }
): NormalizedEvent {
  const updates = extra.subagentUpdates?.length ? { subagentUpdates: extra.subagentUpdates } : {};
  const summary = extra.inputSummary ? { inputSummary: extra.inputSummary } : {};
  if (event.kind === 'tool_call') {
    return {
      ...event,
      title: title ?? event.title,
      toolKind: null,
      ...summary,
      ...updates,
      ...(extra.awaitsSubagents ? { awaitsSubagents: extra.awaitsSubagents } : {}),
    };
  }
  return { ...event, title, toolKind: null, ...summary, ...updates };
}

function enrichActivity(
  event: Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>,
  input: CollabInput,
  meta: CodexMeta['subagent']
): NormalizedEvent | null {
  const threadId = nonEmpty(meta?.threadId) ?? nonEmpty(input.agentThreadId);
  const activity = nonEmpty(meta?.activity) ?? nonEmpty(input.activityKind);
  if (!threadId || !activity) return null;
  const path = nonEmpty(meta?.path) ?? nonEmpty(input.agentPath);
  const name = codexAgentName(path, threadId);
  if (activity === 'started') {
    const model = nonEmpty(meta?.model) ?? nonEmpty(input.model);
    const effort = nonEmpty(input.reasoningEffort);
    return {
      kind: 'subagent',
      operation: event.kind === 'tool_call' ? 'start' : 'update',
      toolCallId: event.toolCallId,
      title: name,
      // Satırın kendi durumu ("başlatma tamamlandı") ajanın durumu değildir: başlatılan ajan
      // çalışıyor sayılır, gerçek sonucu oturum kaydından okunur. Güncelleme durumu değiştirmez.
      status: event.kind === 'tool_call' ? 'in_progress' : null,
      parentToolCallId: event.parentToolCallId,
      agentId: threadId,
      provider: 'codex',
      detached: true,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }
  const title = ACTIVITY_TITLES[activity] ?? 'Alt ajan';
  const finished = event.status === 'completed';
  const subagentUpdates: NormalizedSubagentStatusPatch[] =
    finished && activity === 'interrupted'
      ? [{ agentId: threadId, status: 'failed', interrupted: true, ifRunning: true }]
      : finished && activity === 'completed'
        ? [{ agentId: threadId, status: 'completed' }]
        : [];
  return readableRow(event, title, { inputSummary: name, subagentUpdates });
}

function enrichCollabTool(
  event: Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>,
  tool: string,
  input: CollabInput
): NormalizedEvent {
  const receivers = stringList(input.receiverThreadIds);
  const prompt = nonEmpty(input.prompt);
  const states = asRecord(input.agentsStates);
  if (tool === 'spawnAgent') {
    const agentId = receivers[0];
    const model = nonEmpty(input.model);
    const effort = nonEmpty(input.reasoningEffort);
    const reported = agentId ? agentStatus(states?.[agentId]) : null;
    // Başlatma çağrısının kendisi başarısızsa ajan hiç çalışmadı.
    const status: NormalizedToolStatus | null =
      event.status === 'failed'
        ? 'failed'
        : (reported ?? (event.kind === 'tool_call' ? 'in_progress' : null));
    return {
      kind: 'subagent',
      operation: event.kind === 'tool_call' ? 'start' : 'update',
      toolCallId: event.toolCallId,
      title: agentId ? `Alt ajan ${agentId.slice(-8)}` : 'Alt ajan',
      status,
      parentToolCallId: event.parentToolCallId,
      ...(agentId ? { agentId } : {}),
      provider: 'codex',
      detached: true,
      ...(prompt ? { prompt, inputSummary: preview(prompt) } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }
  const title = COLLAB_TOOL_TITLES[tool] ?? 'Alt ajan aracı';
  const finished = event.status === 'completed' || event.status === 'failed';
  const subagentUpdates = finished ? statusPatches(input.agentsStates) : [];
  if (tool === 'wait') {
    // Başlıktaki sayıyı ayrıştırıcı yazar (`awaitsSubagents`); güncelleme başlığı ezmesin.
    return readableRow(event, event.kind === 'tool_call' ? title : null, {
      subagentUpdates,
      awaitsSubagents: receivers,
    });
  }
  return readableRow(event, title, {
    ...(prompt ? { inputSummary: preview(prompt) } : {}),
    subagentUpdates,
  });
}

/**
 * Codex çoklu ajan satırını çevirir; Codex'in alt ajan satırı değilse `null` döner ve olay
 * olduğu gibi kalır.
 */
export function enrichCodexCollaboration(
  event: NormalizedEvent,
  raw: SessionUpdate
): NormalizedEvent | null {
  if (event.kind !== 'tool_call' && event.kind !== 'tool_update') return null;
  const meta = codexMeta(raw);
  const input = (asRecord((raw as { rawInput?: unknown }).rawInput) ?? {}) as CollabInput;
  if (meta?.subagent || typeof input.activityKind === 'string') {
    return enrichActivity(event, input, meta?.subagent);
  }
  const tool = nonEmpty(asRecord(meta?.collaboration)?.tool);
  if (tool) return enrichCollabTool(event, tool, input);
  return null;
}
