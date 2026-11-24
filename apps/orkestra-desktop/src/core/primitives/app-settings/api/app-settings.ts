import type { TerminalShellId } from '@orkestra/core/primitives/terminal-shell/api';
import type {
  BrowserAgentProfileMode,
  BrowserProfile,
  BrowserProfileSelection,
} from '@core/primitives/browser/api';
import type { OpenInAppId } from '@core/primitives/open-in-apps/api/open-in-apps';

export type LocalProjectSettings = {
  defaultProjectsDirectory: string;
  defaultWorktreeDirectory: string;
};

export type BranchNamingMode = 'static' | 'semantic' | 'custom';

export type ProjectSettings = {
  pushOnCreate: boolean;
  branchPrefix: string;
  branchNamingMode: BranchNamingMode;
  branchNamingInstructions: string;
  autoArchiveMergedPrTasks: boolean;
  appendRandomBranchSuffix: boolean;
  tmuxByDefault: boolean;
};

export type NotificationSettings = {
  enabled: boolean;
  sound: boolean;
  customSoundPath: string;
  osNotifications: boolean;
  soundFocusMode: 'always' | 'unfocused';
};

export type DefaultPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypass';

export type TaskSettings = {
  autoGenerateName: boolean;
  autoApproveByDefault: boolean;
  defaultPermissionMode: DefaultPermissionMode;
  autoTrustWorktrees: boolean;
  createBranchAndWorktree: boolean;
  deleteBranchByDefault: boolean;
  preserveNameCapitalization: boolean;
  includeIssueContextByDefault: boolean;
};

export type FilesSettings = {
  treeExclude: string[];
  searchExclude: string[];
  watcherExclude: string[];
};

export type TerminalSettings = {
  fontFamily?: string;
  fontSize?: number;
  autoCopyOnSelection: boolean;
  macOptionIsMeta: boolean;
  defaultShell: TerminalShellId;
};

export type Theme = 'emlight' | 'emdark' | null;

export type AccentPreset = 'default' | 'ocean' | 'emerald' | 'amber' | 'violet' | 'rose';
export type FontScale = 'compact' | 'default' | 'comfortable';

export type InterfaceSettings = {
  showTrayIcon: boolean;
  taskHoverAction: 'delete' | 'archive';
  autoRightSidebarBehavior: boolean;
  showLeftSidebarLineChanges: boolean;
  showLeftSidebarPrStatus: boolean;
  showLeftSidebarTimestamps: boolean;
  hideContextBar: boolean;
  accentPreset: AccentPreset;
  fontScale: FontScale;
};

export type AntigravityOrchestratorMode =
  | 'standard'
  | 'gemini-pro-orchestrator-neon'
  | 'gemini-pro-orchestrator'
  | 'gemini-pro-orchestrator-argon';

export type ProviderOrchestratorConfig = {
  defaultMode?: AntigravityOrchestratorMode;
  plannerModel?: string;
  executorModel?: string;
};

export type ProviderProfileConfig = {
  id: string;
  name: string;
  extraArgs?: string;
  env?: Record<string, string>;
};

export type ProviderCustomConfig = {
  extraArgs?: string;
  env?: Record<string, string>;
  orchestrator?: ProviderOrchestratorConfig;
  activeProfileId?: string;
  profiles?: ProviderProfileConfig[];
};
export type ProviderCustomConfigs = Record<string, ProviderCustomConfig>;

export type ChangesViewMode = {
  unstaged: 'flat' | 'tree';
  staged: 'flat' | 'tree';
  pr: 'flat' | 'tree';
};

export type BrowserSettings = {
  defaultProfileId: BrowserProfileSelection;
  relaxCorsForLocalhost: boolean;
  profiles: BrowserProfile[];
  /** Ajanın açtığı sekmelerin profili; kullanıcının açtığı sekmeler etkilenmez. */
  agentProfile: BrowserAgentProfileMode;
};

export type KeyboardSettings = Record<string, string | null | undefined>;

export type OpenInSettings = {
  default: OpenInAppId;
  hidden: OpenInAppId[];
};

export type ChangesSection = keyof ChangesViewMode;
export type ChangesListViewMode = ChangesViewMode[ChangesSection];

export type HostSettings = {
  installBaseUrl: string;
};

export type TextGenerationProvider = 'openai-compatible' | 'anthropic';

export type TextGenerationSettings = {
  enabled: boolean;
  provider: TextGenerationProvider;
  baseUrl: string;
  model: string;
  autoTitleTasks: boolean;
  promptSuggestionsEnabled: boolean;
};

export type SecretsSettings = {
  onePasswordEnabled: boolean;
  onePasswordAccount: string;
  redactTranscriptSecrets: boolean;
};

export type SnapshotCaptureMode = 'active-window' | 'interactive';

export type SnapshotSettings = {
  enabled: boolean;
  shortcut: string;
  captureMode: SnapshotCaptureMode;
  includeWindowMetadata: boolean;
};

export type ChatWorkingTurnSubmitMode = 'queue' | 'steer-cancel';

export type ChatSettings = {
  workingTurnSubmitMode: ChatWorkingTurnSubmitMode;
  showContextCompactionBanner: boolean;
  cacheExpiryWarningMinutes: number;
};
