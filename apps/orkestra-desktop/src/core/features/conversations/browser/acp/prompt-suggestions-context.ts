import type { PromptSuggestionTurnActivity } from '@core/features/text-generation/api/contract';

export type SuggestionToolLocation = {
  path?: string;
};

export type SuggestionTurnItem = {
  id?: string;
  kind: string;
  role?: string;
  text?: string;
  path?: string;
  command?: string;
  title?: string;
  inputSummary?: string;
  status?: string;
  locations?: readonly SuggestionToolLocation[];
  children?: readonly SuggestionTurnItem[];
};

export type SuggestionTurnOutcome = {
  kind: 'done' | 'cancelled' | 'error' | 'interrupted';
};

export type SuggestionTurn = {
  id: string;
  items: readonly SuggestionTurnItem[];
  outcome?: SuggestionTurnOutcome;
};

export type ExtractedPromptSuggestionContext = {
  turnId: string;
  outcome?: 'done' | 'cancelled' | 'error' | 'interrupted';
  lastUserText?: string;
  lastAssistantText: string;
  activity: PromptSuggestionTurnActivity;
};

const MAX_ASSISTANT_HEAD_CHARS = 1200;
const MAX_ASSISTANT_TAIL_CHARS = 2600;
const MAX_ASSISTANT_TOTAL_CHARS = 4200;

export function truncateAssistantHeadTail(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.length <= MAX_ASSISTANT_TOTAL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_ASSISTANT_HEAD_CHARS)}\n…\n${trimmed.slice(-MAX_ASSISTANT_TAIL_CHARS)}`;
}

function collectTurnActivity(items: readonly SuggestionTurnItem[]): {
  editedFiles: string[];
  readFilesCount: number;
  executedCommands: Array<{ command: string; failed?: boolean }>;
  createdPlan: boolean;
  failedToolsCount: number;
} {
  const editedFilesSet = new Set<string>();
  const executedCommands: Array<{ command: string; failed?: boolean }> = [];
  let readFilesCount = 0;
  let createdPlan = false;
  let failedToolsCount = 0;

  const visit = (item: SuggestionTurnItem) => {
    switch (item.kind) {
      case 'tool-group':
        break;
      case 'create-file-tool-call':
      case 'modify-file-tool-call':
      case 'delete-file-tool-call': {
        const targetPath = item.path || item.locations?.[0]?.path;
        if (targetPath?.trim()) editedFilesSet.add(targetPath.trim());
        if (item.status === 'error') failedToolsCount += 1;
        break;
      }
      case 'read-tool-call': {
        readFilesCount += 1;
        if (item.status === 'error') failedToolsCount += 1;
        break;
      }
      case 'execute-tool-call': {
        const cmdText = (item.command || item.title || '').replace(/\s+/g, ' ').trim();
        if (cmdText && executedCommands.length < 20) {
          executedCommands.push({
            command: cmdText.slice(0, 400),
            ...(item.status === 'error' ? { failed: true } : {}),
          });
        }
        if (item.status === 'error') failedToolsCount += 1;
        break;
      }
      case 'create-plan-tool-call': {
        createdPlan = true;
        if (item.status === 'error') failedToolsCount += 1;
        break;
      }
      default: {
        if (item.kind.endsWith('-tool-call') && item.status === 'error') {
          failedToolsCount += 1;
        }
        break;
      }
    }

    if (item.children) {
      for (const child of item.children) {
        visit(child);
      }
    }
  };

  for (const item of items) {
    visit(item);
  }

  return {
    editedFiles: [...editedFilesSet].slice(0, 30),
    readFilesCount,
    executedCommands,
    createdPlan,
    failedToolsCount,
  };
}

function findLastUserPrompt(turns: readonly SuggestionTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) continue;
    for (let j = turn.items.length - 1; j >= 0; j -= 1) {
      const item = turn.items[j];
      if (item && item.role === 'user' && typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim().slice(0, 2000);
      }
    }
  }
  return undefined;
}

export function extractPromptSuggestionContext(
  turns: readonly SuggestionTurn[]
): ExtractedPromptSuggestionContext | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn) continue;

    const assistantChunks: string[] = [];
    for (const item of turn.items) {
      if (
        ((item.kind === 'message' && item.role === 'assistant') ||
          item.kind === 'assistant-message' ||
          item.kind === 'text' ||
          (item.role === 'assistant' && !item.kind.endsWith('-tool-call'))) &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
      ) {
        assistantChunks.push(item.text.trim());
      }
    }

    const outcome = turn.outcome?.kind;
    const isUnfinishedOrFailedOutcome =
      outcome === 'cancelled' || outcome === 'error' || outcome === 'interrupted';

    if (assistantChunks.length === 0 && !isUnfinishedOrFailedOutcome) {
      continue;
    }

    const activitySummary = collectTurnActivity(turn.items);
    const lastAssistantText = truncateAssistantHeadTail(assistantChunks.join('\n\n'));
    const lastUserText = findLastUserPrompt(turns.slice(0, i + 1));

    return {
      turnId: turn.id,
      ...(outcome ? { outcome } : {}),
      ...(lastUserText ? { lastUserText } : {}),
      lastAssistantText,
      activity: {
        ...(outcome ? { outcome } : {}),
        ...(activitySummary.editedFiles.length > 0
          ? { editedFiles: activitySummary.editedFiles }
          : {}),
        ...(activitySummary.readFilesCount > 0
          ? { readFilesCount: activitySummary.readFilesCount }
          : {}),
        ...(activitySummary.executedCommands.length > 0
          ? { executedCommands: activitySummary.executedCommands }
          : {}),
        ...(activitySummary.createdPlan ? { createdPlan: true } : {}),
        ...(activitySummary.failedToolsCount > 0
          ? { failedToolsCount: activitySummary.failedToolsCount }
          : {}),
      },
    };
  }

  return null;
}
