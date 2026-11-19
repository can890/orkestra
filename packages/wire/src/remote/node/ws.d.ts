// `ws` paketinin bu modülün kullandığı küçük yüzü. (@types/ws bağımlılığı eklememek için.)
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { AddressInfo } from 'node:net';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export interface ServerOptions {
    host?: string;
    port?: number;
    path?: string;
    backlog?: number;
    maxPayload?: number;
    clientTracking?: boolean;
    perMessageDeflate?: boolean;
  }

  export class WebSocketServer {
    constructor(options: ServerOptions, callback?: () => void);
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'listening', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'listening', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    off(event: 'listening' | 'error', listener: (...args: never[]) => void): this;
    address(): string | AddressInfo | null;
    close(callback?: (error?: Error) => void): void;
  }
}
