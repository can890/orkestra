// `ws` paketi kendi tür tanımlarını getirmez ve `@types/ws` eklenmedi (yeni bağımlılık
// istenmiyor). Yalnızca kullanılan yüzey tanımlanır: uzak erişim geçidi (`@orkestra/wire/remote/node`)
// ve Chrome köprüsü (`src/core/features/chrome`).
//
// Bu dosyanın iki kopyası vardır ve AYNI kalmalıdır (ikisi de aynı programa girebilir):
//   packages/wire/src/remote/node/ws.d.ts
//   apps/orkestra-desktop/src/types/ws.d.ts
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { AddressInfo } from 'node:net';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    static readonly OPEN: 1;
    readonly readyState: number;
    constructor(
      address: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string>; origin?: string }
    );
    send(data: string | Uint8Array, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'open', listener: () => void): this;
    once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(
      event: 'unexpected-response',
      listener: (request: unknown, response: IncomingMessage) => void
    ): this;
  }

  export interface ServerOptions {
    host?: string;
    port?: number;
    path?: string;
    backlog?: number;
    maxPayload?: number;
    clientTracking?: boolean;
    perMessageDeflate?: boolean;
    noServer?: boolean;
    handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
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
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket, request: IncomingMessage) => void
    ): void;
    close(callback?: (error?: Error) => void): void;
  }
}
