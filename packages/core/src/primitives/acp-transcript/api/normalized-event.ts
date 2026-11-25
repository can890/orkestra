import type {
  AvailableCommand,
  SessionConfigOption,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { TranscriptArtifact } from './artifacts';
import type { TranscriptMcpCallPatch } from './mcp-app';
import type { TranscriptWidget } from './widget';

export type AttachmentRef = {
  id: string;
  name: string;
  mimeType: string;
};

export type SessionUsage = {
  contextSize: number;
  contextUsed: number;
  cost: { amount: number; currency: string } | null;
};

export type PlanEntryInput = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
};

export type NormalizedDiff = {
  path: string;
  oldText: string | null;
  newText: string;
};

export type NormalizedToolLocation = {
  path: string;
  line?: number;
};

export type NormalizedToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type NormalizedSubagentActivity = {
  id: string;
  kind: 'thinking' | 'tool' | 'message' | 'error' | 'status';
  title: string;
  detail?: string;
  status?: 'running' | 'done' | 'error';
  timestamp?: number;
};

export type NormalizedEvent =
  | { kind: 'mcp_startup_failure'; server: string; error: string }
  | {
      kind: 'message';
      promptId?: string;
      role: 'user' | 'assistant';
      messageId: string | null;
      text: string;
      createdAt?: number;
      attachments?: AttachmentRef[];
      artifacts?: TranscriptArtifact[];
    }
  | {
      kind: 'thinking';
      messageId: string | null;
      text: string;
    }
  | {
      kind: 'tool_call';
      toolCallId: string;
      title: string;
      toolKind: string | null;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      diffs: NormalizedDiff[];
      locations: NormalizedToolLocation[];
      inputSummary?: string;
      outputText?: string;
      artifacts?: TranscriptArtifact[];
      terminalId?: string;
      /** Doğrulanmış `show_widget` girdisi (yalnızca widget araç çağrılarında). */
      widget?: TranscriptWidget;
      /** MCP araç çağrısı kimliği ve sınırlı girdi/sonuç (MCP uygulamaları için). */
      mcpCall?: TranscriptMcpCallPatch;
      /** Sağlayıcı bu aracı arka plan görevi olarak bildirdi (`_meta.orkestra.backgroundTask`). */
      backgroundTask?: true;
      /** Alt ajan satırı turundan uzun yaşar ve durumu sonra da bildirilir (`_meta.orkestra.detached`). */
      detached?: true;
      /** Sağlayıcı satırın akıbetini bilmiyor (`_meta.orkestra.statusUnknown`). */
      statusUnknown?: true;
    }
  | {
      kind: 'subagent';
      operation?: 'start' | 'update';
      toolCallId: string;
      title: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      inputSummary?: string;
      summary?: string;
      background?: boolean;
      agentId?: string;
      outputFile?: string;
      prompt?: string;
      role?: string;
      provider?: string;
      model?: string;
      effort?: string;
      activities?: NormalizedSubagentActivity[];
    }
  | {
      kind: 'subagent_update';
      toolCallId?: string;
      agentId?: string;
      status: NormalizedToolStatus;
      /**
       * Ajanın akıbeti bilinmiyor (ör. geri yüklenen oturumda bitiş kaydı bulunamadı): artık
       * çalışmıyor sayılır ama "tamamlandı" da denmez. Yalnızca `completed` ile birlikte gönderilir.
       */
      statusUnknown?: true;
      summary?: string;
      outputFile?: string;
      prompt?: string;
      role?: string;
      provider?: string;
      model?: string;
      effort?: string;
      activities?: NormalizedSubagentActivity[];
    }
  | {
      kind: 'search';
      operation?: 'start' | 'update';
      toolCallId: string;
      query: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      matchCount?: number;
    }
  | {
      kind: 'mcp_tool';
      operation?: 'start' | 'update';
      toolCallId: string;
      server?: string;
      tool: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      inputSummary?: string;
    }
  | {
      kind: 'web_fetch';
      operation?: 'start' | 'update';
      toolCallId: string;
      url: string;
      title?: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
    }
  | {
      kind: 'tool_update';
      toolCallId: string;
      title?: string | null;
      toolKind?: string | null;
      status?: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      /** Present only when ACP supplied content; an empty array explicitly clears prior diffs. */
      diffs?: NormalizedDiff[];
      /** Present only when ACP supplied locations; an empty array explicitly clears them. */
      locations?: NormalizedToolLocation[];
      inputSummary?: string;
      outputText?: string;
      artifacts?: TranscriptArtifact[];
      terminalId?: string;
      /** Doğrulanmış `show_widget` girdisi (yalnızca widget araç çağrılarında). */
      widget?: TranscriptWidget;
      /** MCP araç çağrısı kimliği ve sınırlı girdi/sonuç (MCP uygulamaları için). */
      mcpCall?: TranscriptMcpCallPatch;
      /** Sağlayıcı bu aracı arka plan görevi olarak bildirdi (`_meta.orkestra.backgroundTask`). */
      backgroundTask?: true;
      /** Alt ajan satırı turundan uzun yaşar ve durumu sonra da bildirilir (`_meta.orkestra.detached`). */
      detached?: true;
      /** Sağlayıcı satırın akıbetini bilmiyor (`_meta.orkestra.statusUnknown`). */
      statusUnknown?: true;
      /**
       * Bu araç çağrısı bitmiş bir alt ajanı yeniden başlattı (Claude `SendMessage` →
       * `resumedAgentId`); değer ajanın tam kimliğidir.
       */
      resumesAgentId?: string;
    }
  | {
      kind: 'plan';
      entries: PlanEntryInput[];
    }
  | {
      kind: 'config';
      options: ReadonlyArray<SessionConfigOption>;
    }
  | {
      kind: 'mode_selected';
      modeId: string;
    }
  | {
      kind: 'commands';
      commands: ReadonlyArray<AvailableCommand>;
    }
  | {
      kind: 'usage';
      usage: SessionUsage;
    }
  | {
      kind: 'title';
      title: string;
    }
  | { kind: 'ignored' };

export type EnrichHook = (event: NormalizedEvent, raw: SessionUpdate) => NormalizedEvent;
