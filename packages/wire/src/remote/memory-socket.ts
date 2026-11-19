import type { RemoteSocket, RemoteSocketData } from './protocol';

export type MemorySocketPair = {
  client: RemoteSocket;
  server: RemoteSocket;
  /** Her iki yönde geçen ham çerçeveleri (kaydedilmiş trafik) verir; tekrar saldırısı testleri için. */
  recorded: { fromClient: RemoteSocketData[]; fromServer: RemoteSocketData[] };
};

/** Test/örnek için bellek içi, sıralı çift soket (gerçek ağ arayüzü açmaz). */
export function createMemorySocketPair(): MemorySocketPair {
  type Side = {
    message?: (data: RemoteSocketData) => void;
    close?: (code: number, reason: string) => void;
    queue: RemoteSocketData[];
    closeInfo?: { code: number; reason: string };
  };
  const a: Side = { queue: [] };
  const b: Side = { queue: [] };
  const recorded = { fromClient: [] as RemoteSocketData[], fromServer: [] as RemoteSocketData[] };
  let closed = false;

  const makeEndpoint = (self: Side, peer: Side, log: RemoteSocketData[]): RemoteSocket => ({
    send(data) {
      if (closed) throw new Error('Socket closed');
      log.push(typeof data === 'string' ? data : new Uint8Array(data));
      const copy = typeof data === 'string' ? data : new Uint8Array(data);
      queueMicrotask(() => {
        if (peer.message) peer.message(copy);
        else peer.queue.push(copy);
      });
    },
    close(code, reason = '') {
      if (closed) return;
      closed = true;
      const info = { code, reason };
      self.closeInfo = info;
      peer.closeInfo = info;
      queueMicrotask(() => {
        self.close?.(code, reason);
        peer.close?.(code, reason);
      });
    },
    onMessage(cb) {
      self.message = cb;
      for (const item of self.queue.splice(0)) cb(item);
    },
    onClose(cb) {
      self.close = cb;
      if (self.closeInfo) cb(self.closeInfo.code, self.closeInfo.reason);
    },
  });

  return {
    client: makeEndpoint(a, b, recorded.fromClient),
    server: makeEndpoint(b, a, recorded.fromServer),
    recorded,
  };
}
