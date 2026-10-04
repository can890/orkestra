import type { Readable, Writable } from 'node:stream';
import type { Controller } from '@orkestra/wire/rpc';
import { serve, streamTransport } from '@orkestra/wire/rpc';

export type StdioStreams = {
  input: Readable;
  output: Writable;
};

export function serveStdio(
  controller: Controller,
  streams: StdioStreams = { input: process.stdin, output: process.stdout }
): () => void {
  return serve(streamTransport(streams.input, streams.output), controller);
}
