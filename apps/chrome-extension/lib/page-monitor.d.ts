export type OrkestraConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  message: string;
  source?: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
};

export type OrkestraNetworkEntry = {
  url: string;
  method: string;
  status: number;
  statusText?: string;
  ok?: boolean;
  type: string;
  error?: string;
  durationMs: number;
  duration: number;
  timestamp: number;
};

export type OrkestraPageMonitorState = {
  installed: boolean;
  console: OrkestraConsoleEntry[];
  network: OrkestraNetworkEntry[];
  seenResourceCount: number;
  clearedAtPerfTime: number;
  syncPerformanceResources?: () => void;
};
