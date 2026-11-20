/**
 * Masaüstü yanıtlarından telefon ekranlarının görünüm modellerine eşleme. Girdi `unknown`'dır:
 * uzak veriye güvenilmez, eksik/yanlış tipli alanlar atlanır ya da varsayılana düşer.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// --- Projeler / görevler / sohbetler ---------------------------------------------------------

export type ProjectView = {
  id: string;
  name: string;
  path: string;
  remote: boolean;
  hostRef: string;
  repositoryWorkspaceId: string | null;
};

export function mapProjects(data: unknown): ProjectView[] {
  const projects = isRecord(data) ? arr(data['projects']) : [];
  return projects
    .filter(isRecord)
    .filter((project) => str(project['id']) !== '')
    .map((project) => {
      const remote = project['type'] === 'ssh';
      const connectionId = str(project['connectionId']);
      return {
        id: str(project['id']),
        name: str(project['name'], 'Adsız proje'),
        path: str(project['path']),
        remote,
        hostRef:
          remote && connectionId ? `remote:${encodeURIComponent(connectionId)}` : 'local:local',
        repositoryWorkspaceId:
          typeof project['repositoryWorkspaceId'] === 'string' &&
          project['repositoryWorkspaceId'].trim()
            ? project['repositoryWorkspaceId']
            : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled'
  | 'backlog'
  | 'duplicate'
  | 'triage'
  | 'unknown';

const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'backlog',
  'duplicate',
  'triage',
];

export type TaskView = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatus;
  pinned: boolean;
  /** ISO; sıralama için en son etkileşim ya da güncelleme. */
  activityAt: string;
};

export function mapTasks(data: unknown, projectId: string): TaskView[] {
  const tasks = isRecord(data) ? arr(data['tasks']) : [];
  return tasks
    .filter(isRecord)
    .filter((task) => str(task['id']) !== '' && task['archivedAt'] === undefined)
    .map((task) => {
      const status = TASK_STATUSES.find((candidate) => candidate === task['status']) ?? 'unknown';
      return {
        id: str(task['id']),
        projectId: str(task['projectId'], projectId),
        name: str(task['name'], 'Adsız görev'),
        status,
        pinned: task['isPinned'] === true,
        activityAt: str(task['lastInteractedAt']) || str(task['updatedAt']),
      };
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.activityAt.localeCompare(a.activityAt);
    });
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return 'Yapılacak';
    case 'in_progress':
      return 'Sürüyor';
    case 'review':
      return 'İncelemede';
    case 'done':
      return 'Bitti';
    case 'cancelled':
      return 'İptal';
    case 'backlog':
      return 'Biriktirilen';
    case 'duplicate':
      return 'Yinelenen';
    case 'triage':
      return 'Ön eleme';
    default:
      return 'Bilinmiyor';
  }
}

export type ConversationView = {
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  providerId: string;
  /** Yalnızca yapılandırılmış (ACP) sohbetler telefondan sürdürülebilir; terminal oturumları değil. */
  chatCapable: boolean;
  lastInteractedAt: string | null;
  agentStatus: string | null;
};

export function mapConversations(data: unknown): ConversationView[] {
  return arr(data)
    .filter(isRecord)
    .filter((conversation) => str(conversation['id']) !== '')
    .map((conversation) => {
      const status = conversation['agentStatus'];
      return {
        id: str(conversation['id']),
        taskId: str(conversation['taskId']),
        projectId: str(conversation['projectId']),
        title: str(conversation['title']) || 'Adsız sohbet',
        providerId: str(conversation['providerId']),
        chatCapable: conversation['type'] === 'acp',
        lastInteractedAt:
          typeof conversation['lastInteractedAt'] === 'string'
            ? conversation['lastInteractedAt']
            : null,
        agentStatus: typeof status === 'string' ? status : null,
      };
    })
    .sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''));
}

// --- Oturum durumu ----------------------------------------------------------------------------

export type Lifecycle = 'starting' | 'replaying' | 'ready' | 'working' | 'cancelling' | 'closed';
const LIFECYCLES: readonly Lifecycle[] = [
  'starting',
  'replaying',
  'ready',
  'working',
  'cancelling',
  'closed',
];

export type PermissionOptionView = { optionId: string; name: string; allow: boolean };
export type PermissionView = {
  requestId: string;
  title: string;
  detail: string | null;
  options: PermissionOptionView[];
};

export type SessionView = {
  lifecycle: Lifecycle;
  suspended: boolean;
  isGenerating: boolean;
  canSubmit: boolean;
  canCancel: boolean;
  queuedCount: number;
  permissions: PermissionView[];
  historyRevision: number;
  generation: string | null;
  activeTurn: unknown;
};

export function mapSessionState(data: unknown): SessionView {
  const state = isRecord(data) ? data : {};
  const lifecycle = LIFECYCLES.find((candidate) => candidate === state['lifecycle']) ?? 'starting';
  const transcript = isRecord(state['transcript']) ? state['transcript'] : null;
  return {
    lifecycle,
    suspended: state['suspended'] === true,
    isGenerating: state['isGenerating'] === true,
    canSubmit: state['canSubmit'] === true,
    canCancel: state['canCancel'] === true,
    queuedCount: arr(state['queuedPrompts']).length,
    permissions: arr(state['pendingPermissions']).filter(isRecord).map(mapPermission),
    historyRevision: num(state['historyRevision']) ?? num(transcript?.['historyRevision']) ?? 0,
    generation: transcript ? str(transcript['generation']) || null : null,
    activeTurn: transcript?.['activeTurn'] ?? null,
  };
}

function mapPermission(request: Record<string, unknown>): PermissionView {
  const toolCall = isRecord(request['toolCall']) ? request['toolCall'] : {};
  const detail =
    str(toolCall['command']) ||
    str(toolCall['path']) ||
    str(toolCall['url']) ||
    str(toolCall['query']) ||
    str(toolCall['inputSummary']);
  return {
    requestId: str(request['requestId']),
    title: str(toolCall['title']) || 'İzin isteği',
    detail: detail || null,
    options: arr(request['options'])
      .filter(isRecord)
      .filter((option) => str(option['optionId']) !== '')
      .map((option) => ({
        optionId: str(option['optionId']),
        name: str(option['name'], str(option['optionId'])),
        allow: str(option['kind']).startsWith('allow'),
      })),
  };
}

// --- Döküm ------------------------------------------------------------------------------------

export type ToolStatusView = 'running' | 'done' | 'failed' | 'unknown';

export type TranscriptEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; promptId?: string }
  | { kind: 'thinking'; id: string; text: string; active: boolean }
  | {
      kind: 'tool';
      id: string;
      title: string;
      status: ToolStatusView;
      detail: string | null;
      children: TranscriptEntry[];
    }
  | { kind: 'notice'; id: string; tone: 'error' | 'info'; text: string };

function toolStatus(value: unknown): ToolStatusView {
  switch (value) {
    case 'pending':
    case 'running':
    case 'in_progress':
      return 'running';
    case 'completed':
    case 'done':
    case 'success':
      return 'done';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

function mapItem(item: Record<string, unknown>): TranscriptEntry | null {
  const id = str(item['id']);
  switch (item['kind']) {
    case 'message': {
      const role = item['role'] === 'user' ? 'user' : 'assistant';
      const text = str(item['text']);
      const promptId = typeof item['promptId'] === 'string' ? item['promptId'] : undefined;
      return { kind: 'message', id, role, text, ...(promptId ? { promptId } : {}) };
    }
    case 'thinking':
      return {
        kind: 'thinking',
        id,
        text: str(item['text']),
        active: item['status'] === 'thinking',
      };
    case 'tool-group':
      return {
        kind: 'tool',
        id,
        title: str(item['label'], 'Araç çağrıları'),
        status: toolStatus(item['status']),
        detail: null,
        children: arr(item['children']).filter(isRecord).map(mapItem).filter(isEntry),
      };
    default: {
      if (typeof item['kind'] === 'string' && item['kind'].endsWith('-tool-call')) {
        const detail =
          str(item['command']) ||
          str(item['path']) ||
          str(item['url']) ||
          str(item['query']) ||
          str(item['inputSummary']);
        return {
          kind: 'tool',
          id,
          title: str(item['title']) || str(item['name']) || 'Araç çağrısı',
          status: toolStatus(item['status']),
          detail: detail || null,
          children: arr(item['children']).filter(isRecord).map(mapItem).filter(isEntry),
        };
      }
      return null;
    }
  }
}

const isEntry = (entry: TranscriptEntry | null): entry is TranscriptEntry => entry !== null;

/** Bir turun öğelerini sırayla dökümde gösterilecek girdilere çevirir (+ sonuç bildirimi). */
export function mapTurn(turn: unknown): TranscriptEntry[] {
  if (!isRecord(turn)) return [];
  const turnId = str(turn['id']);
  const entries = arr(turn['items']).filter(isRecord).map(mapItem).filter(isEntry);
  const outcome = isRecord(turn['outcome']) ? turn['outcome'] : null;
  if (outcome?.['kind'] === 'error') {
    entries.push({
      kind: 'notice',
      id: `${turnId}:outcome`,
      tone: 'error',
      text: str(outcome['message']) || 'Tur hatayla sonlandı.',
    });
  } else if (outcome?.['kind'] === 'cancelled') {
    entries.push({
      kind: 'notice',
      id: `${turnId}:outcome`,
      tone: 'info',
      text: 'Tur iptal edildi.',
    });
  }
  return entries;
}

export type HistoryPageView = {
  turns: unknown[];
  nextCursor: number | null;
  generation: string | null;
  historyRevision: number | null;
  unavailable: boolean;
};

export function mapHistoryPage(data: unknown): HistoryPageView {
  const page = isRecord(data) ? data : {};
  const position = isRecord(page['position']) ? page['position'] : null;
  return {
    turns: arr(page['turns']),
    nextCursor: num(page['nextCursor']),
    generation: position ? str(position['generation']) || null : null,
    historyRevision: position ? num(position['historyRevision']) : null,
    unavailable: page['unavailable'] === true,
  };
}

export function turnSeq(turn: unknown): number {
  return isRecord(turn) ? (num(turn['seq']) ?? 0) : 0;
}
export function turnId(turn: unknown): string {
  return isRecord(turn) ? str(turn['id']) : '';
}

// --- Hesaplar / kullanım ----------------------------------------------------------------------

export type AuthKind = 'authenticated' | 'unauthenticated' | 'unknown';

export type AccountView = {
  providerId: string;
  name: string;
  auth: AuthKind;
  account: string | null;
  message: string | null;
};

export function mapAccounts(data: unknown): AccountView[] {
  if (!isRecord(data)) return [];
  return Object.values(data)
    .filter(isRecord)
    .filter((entry) => str(entry['providerId']) !== '')
    .map((entry) => {
      const auth = isRecord(entry['auth']) ? entry['auth'] : {};
      const status = isRecord(auth['status']) ? auth['status'] : {};
      const kind: AuthKind =
        status['kind'] === 'authenticated'
          ? 'authenticated'
          : status['kind'] === 'unauthenticated'
            ? 'unauthenticated'
            : 'unknown';
      return {
        providerId: str(entry['providerId']),
        name: str(entry['name']) || str(entry['providerId']),
        auth: kind,
        // Hesap adı/e-postası gösterilir; token'lar zaten masaüstünden çıkmaz.
        account: typeof status['account'] === 'string' ? status['account'] : null,
        message: typeof status['message'] === 'string' ? status['message'] : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

export function authLabel(kind: AuthKind): string {
  return kind === 'authenticated'
    ? 'Bağlı'
    : kind === 'unauthenticated'
      ? 'Oturum açılmamış'
      : 'Durum bilinmiyor';
}

export type UsageWindowView = { label: string; usedPercent: number; resetsAt: string | null };
export type ProviderUsageView = {
  providerId: string;
  status: 'available' | 'unavailable' | 'auth-required' | 'error';
  plan: string | null;
  account: string | null;
  message: string | null;
  windows: UsageWindowView[];
  balances: { label: string; value: number; unit: string }[];
};

export function mapUsage(data: unknown): ProviderUsageView[] {
  const providers = isRecord(data) ? arr(data['providers']) : [];
  return providers
    .filter(isRecord)
    .filter((provider) => str(provider['providerId']) !== '')
    .map((provider) => {
      const status = provider['status'];
      return {
        providerId: str(provider['providerId']),
        status:
          status === 'available' || status === 'auth-required' || status === 'error'
            ? status
            : 'unavailable',
        plan: typeof provider['plan'] === 'string' ? provider['plan'] : null,
        account: typeof provider['account'] === 'string' ? provider['account'] : null,
        message: typeof provider['message'] === 'string' ? provider['message'] : null,
        windows: arr(provider['windows'])
          .filter(isRecord)
          .map((window) => ({
            label: str(window['label']),
            usedPercent: Math.min(100, Math.max(0, num(window['usedPercent']) ?? 0)),
            resetsAt: typeof window['resetsAt'] === 'string' ? window['resetsAt'] : null,
          })),
        balances: arr(provider['balances'])
          .filter(isRecord)
          .map((balance) => ({
            label: str(balance['label']),
            value: num(balance['value']) ?? 0,
            unit: str(balance['unit']),
          })),
      };
    });
}

export type AgentMetaView = { id: string; name: string };

/** Ajan/sağlayıcı kimliğinden görünen ad (listMetadata). Biçim bilinmiyorsa kimlik döner. */
export function mapAgentNames(data: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  for (const entry of arr(data).filter(isRecord)) {
    const id = str(entry['id']) || str(entry['providerId']);
    const name = str(entry['name']) || str(entry['displayName']);
    if (id && name) names[id] = name;
  }
  return names;
}

// --- Canlı oturum özetleri, yapılandırma, bağlam kullanımı ve plan ---------------------------

export type SessionSummaryView = {
  conversationId: string;
  providerId: string;
  lifecycle: Lifecycle;
  isGenerating: boolean;
  pendingPermissionCount: number;
  backgroundAgentCount: number;
  queuedPromptCount: number;
  title: string | null;
  updatedAt: number;
};

export function isSessionLiveWorking(summary: SessionSummaryView | undefined): boolean {
  if (!summary) return false;
  return (
    summary.isGenerating || summary.lifecycle === 'working' || summary.backgroundAgentCount > 0
  );
}

export function isConversationWorking(
  conv: ConversationView | undefined,
  summary: SessionSummaryView | undefined
): boolean {
  if (summary) return isSessionLiveWorking(summary);
  return conv?.agentStatus === 'working';
}

export function isConversationAwaitingPermission(
  conv: ConversationView | undefined,
  summary: SessionSummaryView | undefined
): boolean {
  if (summary && summary.pendingPermissionCount > 0) return true;
  return conv?.agentStatus === 'awaiting-input';
}

export type ActiveWorkItem = {
  conversationId: string;
  title: string;
  providerId: string;
  projectId: string | undefined;
  taskId: string | undefined;
  chatCapable: boolean;
  working: boolean;
  pendingPermissionCount: number;
  awaitingInput: boolean;
  backgroundAgentCount: number;
  updatedAt: number;
};

/**
 * Canlı ACP oturum özetleri ile masaüstü veritabanı `agentStatus` bilgisini tekilleştirip
 * aktif çalışan / onay bekleyen tüm işleri önem ve güncelliğe göre sıralar.
 */
export function buildActiveWorkList(
  conversations: readonly ConversationView[],
  sessions: Readonly<Record<string, SessionSummaryView>>
): ActiveWorkItem[] {
  const convById = new Map(conversations.map((c) => [c.id, c]));
  const items = new Map<string, ActiveWorkItem>();

  for (const summary of Object.values(sessions)) {
    const conv = convById.get(summary.conversationId);
    const working = isSessionLiveWorking(summary);
    const pendingPermissionCount = summary.pendingPermissionCount;
    const awaitingInput = pendingPermissionCount > 0 || conv?.agentStatus === 'awaiting-input';
    if (!working && !awaitingInput) continue;

    const convUpdatedAt = conv?.lastInteractedAt ? Date.parse(conv.lastInteractedAt) : 0;
    items.set(summary.conversationId, {
      conversationId: summary.conversationId,
      title: conv?.title || summary.title || 'Aktif sohbet',
      providerId: conv?.providerId || summary.providerId,
      projectId: conv?.projectId,
      taskId: conv?.taskId,
      chatCapable: conv ? conv.chatCapable : true,
      working,
      pendingPermissionCount,
      awaitingInput,
      backgroundAgentCount: summary.backgroundAgentCount,
      updatedAt: Math.max(summary.updatedAt, Number.isFinite(convUpdatedAt) ? convUpdatedAt : 0),
    });
  }

  for (const conv of conversations) {
    if (items.has(conv.id)) continue;
    const summary = sessions[conv.id];
    const working = isConversationWorking(conv, summary);
    const awaitingInput = isConversationAwaitingPermission(conv, summary);
    if (!working && !awaitingInput) continue;

    const parsedTime = conv.lastInteractedAt ? Date.parse(conv.lastInteractedAt) : 0;
    items.set(conv.id, {
      conversationId: conv.id,
      title: conv.title,
      providerId: conv.providerId,
      projectId: conv.projectId,
      taskId: conv.taskId,
      chatCapable: conv.chatCapable,
      working,
      pendingPermissionCount: summary?.pendingPermissionCount ?? 0,
      awaitingInput,
      backgroundAgentCount: summary?.backgroundAgentCount ?? 0,
      updatedAt: Number.isFinite(parsedTime) ? parsedTime : 0,
    });
  }

  return [...items.values()].sort((a, b) => {
    const aAlert = a.awaitingInput ? 1 : 0;
    const bAlert = b.awaitingInput ? 1 : 0;
    if (aAlert !== bAlert) return bAlert - aAlert;
    if (a.pendingPermissionCount !== b.pendingPermissionCount) {
      return b.pendingPermissionCount - a.pendingPermissionCount;
    }
    return b.updatedAt - a.updatedAt;
  });
}

export function mapSessionSummaries(data: unknown): Record<string, SessionSummaryView> {
  if (!isRecord(data)) return {};
  const result: Record<string, SessionSummaryView> = {};
  for (const [key, raw] of Object.entries(data)) {
    if (!isRecord(raw)) continue;
    const conversationId = str(raw['conversationId']) || key;
    if (!conversationId) continue;
    const lifecycle = LIFECYCLES.find((candidate) => candidate === raw['lifecycle']) ?? 'ready';
    result[conversationId] = {
      conversationId,
      providerId: str(raw['providerId']),
      lifecycle,
      isGenerating: raw['isGenerating'] === true,
      pendingPermissionCount: num(raw['pendingPermissionCount']) ?? 0,
      backgroundAgentCount: num(raw['backgroundAgentCount']) ?? 0,
      queuedPromptCount: num(raw['queuedPromptCount']) ?? 0,
      title: typeof raw['title'] === 'string' && raw['title'].trim() ? raw['title'] : null,
      updatedAt: num(raw['updatedAt']) ?? 0,
    };
  }
  return result;
}

export type SessionConfigView = {
  modelLabel: string | null;
  modeLabel: string | null;
  effortLabel: string | null;
};

function resolveSelectedOptionLabel(slice: unknown): string | null {
  if (!isRecord(slice)) return null;
  const selected = str(slice['selected']);
  if (!selected) return null;
  for (const option of arr(slice['available']).filter(isRecord)) {
    const optionId = str(option['id']) || str(option['value']);
    if (optionId === selected) {
      return str(option['name']) || str(option['label']) || selected;
    }
  }
  return selected;
}

export function mapSessionConfig(data: unknown): SessionConfigView {
  if (!isRecord(data)) return { modelLabel: null, modeLabel: null, effortLabel: null };
  return {
    modelLabel: resolveSelectedOptionLabel(data['modelOptions']),
    modeLabel:
      resolveSelectedOptionLabel(data['collaborationModeOptions']) ??
      resolveSelectedOptionLabel(data['modeOptions']),
    effortLabel: resolveSelectedOptionLabel(data['efforts']),
  };
}

export type SessionUsageView = {
  contextUsed: number;
  contextSize: number;
  percent: number;
};

export function mapSessionUsage(data: unknown): SessionUsageView | null {
  if (!isRecord(data)) return null;
  const contextSize = num(data['contextSize']);
  const contextUsed = num(data['contextUsed']);
  if (contextSize === null || contextUsed === null || contextSize <= 0) return null;
  return {
    contextUsed: Math.max(0, contextUsed),
    contextSize,
    percent: Math.min(100, Math.max(0, Math.round((contextUsed / contextSize) * 100))),
  };
}

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryView = { id: string; content: string; status: PlanEntryStatus };

export function mapSessionPlan(data: unknown): PlanEntryView[] {
  if (!isRecord(data)) return [];
  return arr(data['entries'])
    .filter(isRecord)
    .map((entry, index) => {
      const status = entry['status'];
      const normalizedStatus: PlanEntryStatus =
        status === 'completed' || status === 'in_progress' ? status : 'pending';
      return {
        id: str(entry['id']) || `plan-${index}`,
        content: str(entry['content']),
        status: normalizedStatus,
      };
    })
    .filter((entry) => entry.content.trim() !== '');
}
