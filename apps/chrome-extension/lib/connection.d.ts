export const RETRY_DELAYS_MS: readonly number[];
export const CLOSE_WAIT_MS: number;
export const CONNECT_ERROR: string;
export const TOKEN_ERROR: string;

export type ConnectionSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(code?: number, reason?: string): void;
};

export type ConnectionSettings = {
  enabled: boolean;
  connection: { url: string; protocols: string[] } | null;
};

export type ConnectionStatus = {
  state: 'disconnected' | 'connecting' | 'connected';
  lastError: string;
};

export function createConnectionManager(deps: {
  readSettings: () => Promise<ConnectionSettings>;
  createSocket: (url: string, protocols: string[]) => ConnectionSocket;
  onMessage: (socket: ConnectionSocket, data: unknown) => void;
}): {
  connect(): Promise<void>;
  disconnect(): void;
  status(): ConnectionStatus;
};
