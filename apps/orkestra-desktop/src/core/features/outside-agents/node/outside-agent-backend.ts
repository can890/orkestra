import type { AgentStatus } from '@core/primitives/agents/api';

/**
 * Dış ajan araçlarının Orkestra'ya eriştiği dar yüzey. Gerçek uygulama
 * (`controllers-backend.ts`) masaüstü Wire denetleyicilerini arayüzün ve mobil uygulamanın
 * kullandığı yordamlarla çağırır; testler sahte bir uygulama verir.
 */

export type OutsideProject = Readonly<{
  id: string;
  name: string;
  path: string;
  /** `local` bu makine, `ssh` uzak makine. */
  location: 'local' | 'ssh';
  /** Projenin kendi git checkout'u (çalışma alanı kimliği); depo yoksa null. */
  repositoryWorkspaceId: string | null;
  /** `conversations.acp.sessions.list` anahtarındaki biçimlendirilmiş host. */
  hostKey: string;
}>;

export type OutsideConversation = Readonly<{
  id: string;
  projectId: string;
  taskId: string;
  providerId: string;
  title: string;
  /** `acp` sohbet arayüzü; `pty` terminal/TUI oturumu. */
  type: 'acp' | 'pty';
  model: string | null;
  lastInteractedAt: string | null;
  agentStatus: AgentStatus | null;
  /** Sağlayıcı oturumu hiç kurulmadıysa false. */
  hasSession: boolean;
}>;

/** Canlı ACP oturum özeti (`conversations.acp.sessions.list`). */
export type OutsideSessionSummary = Readonly<{
  lifecycle: string;
  suspended: boolean;
  isGenerating: boolean;
  pendingPermissionCount: number;
  queuedPromptCount: number;
  lastTurnErrored: boolean;
  updatedAt: number | null;
}>;

export type OutsideTranscriptItem = Readonly<
  | { kind: 'message'; role: 'user' | 'assistant'; text: string; createdAt: number | null }
  | { kind: 'tool'; title: string; status: string }
>;

export type OutsideTranscriptTurn = Readonly<{
  seq: number;
  outcome: string | null;
  items: readonly OutsideTranscriptItem[];
}>;

export type OutsideHistoryPage = Readonly<{
  turns: readonly OutsideTranscriptTurn[];
  /** Daha eski turlar için çalışma zamanının imleci; yoksa null. */
  nextCursor: number | null;
}>;

export type OutsideProviderModel = Readonly<{ id: string; name: string; description?: string }>;

export type OutsideProvider = Readonly<{
  id: string;
  name: string;
  /** Bu makinede kurulu mu; bilinemiyorsa null. */
  installed: boolean | null;
  models: readonly OutsideProviderModel[];
  supportsEffort: boolean;
}>;

export type StartConversationInput = Readonly<{
  project: OutsideProject;
  provider: string;
  title: string;
  message: string;
  model?: string;
  effort?: string;
}>;

export type StartConversationResult = Readonly<{
  conversationId: string;
  taskId: string;
  /** Ajan oturumu hemen başlatıldı mı (false ise sohbet Orkestra'da açılınca başlar). */
  started: boolean;
  note?: string;
}>;

export interface OutsideAgentBackend {
  listProjects(): Promise<OutsideProject[]>;
  listConversations(projectId?: string): Promise<OutsideConversation[]>;
  /** Projenin makinesindeki canlı ACP oturumları (sohbet kimliğine göre). */
  sessionSummaries(project: OutsideProject): Promise<Record<string, OutsideSessionSummary>>;
  /** Canlı oturumdan geçmiş sayfası; okunamazsa null. */
  loadLiveHistory(
    conversationId: string,
    limit: number,
    before: number | undefined
  ): Promise<OutsideHistoryPage | null>;
  /** Oturum başlatmadan önbellekteki döküm (eskiden yeniye tüm turlar). */
  loadCachedHistory(conversationId: string): Promise<OutsideTranscriptTurn[]>;
  listProviders(): Promise<OutsideProvider[]>;
  startConversation(input: StartConversationInput): Promise<StartConversationResult>;
  sendMessage(
    conversationId: string,
    text: string,
    placement: 'auto' | 'queue'
  ): Promise<{ queued: boolean }>;
}
