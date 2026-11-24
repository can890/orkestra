import type { Unsubscribe } from '@orkestra/shared';
import { isWireMessage, type WireMessage, type WireTransport } from '../protocol';

type ReadableLike = {
  on(event: 'data', cb: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'close' | 'end' | 'error', cb: () => void): unknown;
};

type WritableLike = {
  write(chunk: string | Uint8Array): unknown;
};

type Bytes = Uint8Array<ArrayBufferLike>;

const FRAME_JSON = 0x00;
const FRAME_BINARY = 0x01;
const HEADER_BYTES = 5;
const BODY_LENGTH_BYTES = 4;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function streamTransport(input: ReadableLike, output: WritableLike): WireTransport {
  const messageListeners = new Set<(message: WireMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  const queue = new ByteQueue();
  let disconnected = false;

  const notifyDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    for (const listener of disconnectListeners) listener();
  };

  input.on('data', (chunk) => {
    if (disconnected) return;
    queue.push(normalizeChunk(chunk));
    try {
      emitParsedFrames(queue, messageListeners, notifyDisconnect);
    } catch {
      notifyDisconnect();
    }
  });
  input.on('close', notifyDisconnect);
  input.on('end', notifyDisconnect);
  input.on('error', notifyDisconnect);

  return {
    post(message) {
      if (disconnected) throw new Error('Stream transport disconnected');
      output.write(encodeFrame(message));
    },
    onMessage(cb): Unsubscribe {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onDisconnect(cb): Unsubscribe {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    close() {
      notifyDisconnect();
      messageListeners.clear();
      disconnectListeners.clear();
      queue.clear();
    },
  };
}

function encodeFrame(message: WireMessage): Uint8Array {
  if (message.kind === 'blob-chunk') {
    const header = encodeJson({
      kind: message.kind,
      channel: message.channel,
      seq: message.seq,
    });
    const body = message.data;
    const frame = new Uint8Array(
      HEADER_BYTES + header.byteLength + BODY_LENGTH_BYTES + body.byteLength
    );
    frame[0] = FRAME_BINARY;
    writeU32(frame, 1, header.byteLength);
    frame.set(header, HEADER_BYTES);
    writeU32(frame, HEADER_BYTES + header.byteLength, body.byteLength);
    frame.set(body, HEADER_BYTES + header.byteLength + BODY_LENGTH_BYTES);
    return frame;
  }

  const header = encodeJson(message);
  const frame = new Uint8Array(HEADER_BYTES + header.byteLength);
  frame[0] = FRAME_JSON;
  writeU32(frame, 1, header.byteLength);
  frame.set(header, HEADER_BYTES);
  return frame;
}

/** O(1) push / O(N) consume chunk queue; avoids O(N²) reallocation on multi-chunk frames. */
class ByteQueue {
  private chunks: Bytes[] = [];
  private headOffset = 0;
  private totalLength = 0;

  get length(): number {
    return this.totalLength;
  }

  push(chunk: Bytes): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  clear(): void {
    this.chunks = [];
    this.headOffset = 0;
    this.totalLength = 0;
  }

  peekByte(offset: number): number {
    let remaining = offset + this.headOffset;
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i]!;
      if (remaining < chunk.byteLength) return chunk[remaining]!;
      remaining -= chunk.byteLength;
    }
    return 0;
  }

  peekU32(offset: number): number {
    const b0 = this.peekByte(offset);
    const b1 = this.peekByte(offset + 1);
    const b2 = this.peekByte(offset + 2);
    const b3 = this.peekByte(offset + 3);
    return b0 * 0x1000000 + ((b1 << 16) | (b2 << 8) | b3);
  }

  skip(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const available = head.byteLength - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        this.totalLength -= remaining;
        return;
      }
      remaining -= available;
      this.totalLength -= available;
      this.chunks.shift();
      this.headOffset = 0;
    }
  }

  take(count: number): Bytes {
    if (count === 0) return new Uint8Array(0);
    const head = this.chunks[0]!;
    const available = head.byteLength - this.headOffset;
    if (count <= available) {
      const slice = head.subarray(this.headOffset, this.headOffset + count);
      this.headOffset += count;
      this.totalLength -= count;
      if (this.headOffset === head.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return slice;
    }
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count && this.chunks.length > 0) {
      const cur = this.chunks[0]!;
      const curAvail = cur.byteLength - this.headOffset;
      const toCopy = Math.min(curAvail, count - written);
      out.set(cur.subarray(this.headOffset, this.headOffset + toCopy), written);
      written += toCopy;
      this.headOffset += toCopy;
      this.totalLength -= toCopy;
      if (this.headOffset === cur.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return out;
  }
}

function emitParsedFrames(
  queue: ByteQueue,
  listeners: Set<(message: WireMessage) => void>,
  disconnect: () => void
): void {
  while (queue.length >= HEADER_BYTES) {
    const kind = queue.peekByte(0);
    const headerLength = queue.peekU32(1);
    if (headerLength > MAX_FRAME_BYTES) {
      queue.clear();
      disconnect();
      return;
    }
    const headerEnd = HEADER_BYTES + headerLength;
    if (queue.length < headerEnd) return;

    if (kind === FRAME_JSON) {
      queue.skip(HEADER_BYTES);
      const headerBytes = queue.take(headerLength);
      emitParsedMessage(headerBytes, undefined, listeners);
      continue;
    }

    if (kind !== FRAME_BINARY) {
      queue.clear();
      disconnect();
      return;
    }

    if (queue.length - headerEnd < BODY_LENGTH_BYTES) return;
    const bodyLength = queue.peekU32(headerEnd);
    if (bodyLength > MAX_FRAME_BYTES) {
      queue.clear();
      disconnect();
      return;
    }
    const bodyEnd = headerEnd + BODY_LENGTH_BYTES + bodyLength;
    if (queue.length < bodyEnd) return;
    queue.skip(HEADER_BYTES);
    const headerBytes = queue.take(headerLength);
    queue.skip(BODY_LENGTH_BYTES);
    const bodyBytes = queue.take(bodyLength);
    emitParsedMessage(headerBytes, bodyBytes, listeners);
  }
}

function emitParsedMessage(
  headerBytes: Uint8Array,
  body: Bytes | undefined,
  listeners: Set<(message: WireMessage) => void>
): void {
  const parsed: unknown = JSON.parse(decodeText(headerBytes));
  const message = body
    ? { ...(parsed as Record<string, unknown>), data: new Uint8Array(body) }
    : parsed;
  if (!isWireMessage(message)) return;
  for (const listener of listeners) listener(message);
}

function encodeJson(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value));
}

function normalizeChunk(chunk: Uint8Array | string): Bytes {
  return typeof chunk === 'string' ? new Uint8Array(encodeText(chunk)) : new Uint8Array(chunk);
}

function encodeText(value: string): Uint8Array {
  return new globalThis.TextEncoder().encode(value);
}

function decodeText(value: Uint8Array): string {
  return new globalThis.TextDecoder().decode(value);
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}
