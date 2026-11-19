// `ws` paketi kendi tür tanımlarını getirmez ve `@types/ws` eklenmedi (yeni bağımlılık
// istenmiyor). Yalnızca Chrome köprüsünün kullandığı küçük yüzey burada tanımlanır.
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    static readonly OPEN: 1;
    readonly readyState: number;
    send(data: string, callback?: (error?: Error) => void): void;
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
    constructor(
      address: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string>; origin?: string }
    );
  }

  export class WebSocketServer {
    constructor(options: {
      noServer: true;
      maxPayload?: number;
      handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
    });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket, request: IncomingMessage) => void
    ): void;
    close(callback?: () => void): void;
  }
}
