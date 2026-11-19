import { safeArtifactUrl } from '@lib/artifact-references';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import { createSignal, untrack } from 'solid-js';
import type { ChatCommands } from '../commands';

/** Concurrent probes in flight; each one can be an SSH round trip. */
const MAX_IN_FLIGHT = 4;

type Entry = {
  artifact: TranscriptArtifact;
  // 'failed': the probe itself failed (connection down, ...). Shown, so a real output never
  // vanishes; the card's own error then explains the problem.
  state: 'unknown' | 'present' | 'missing' | 'failed';
  probing: boolean;
  // Invalidated while a probe was in flight: probe once more when it settles.
  again: boolean;
};

const isShown = (entry: Entry) => entry.state === 'present' || entry.state === 'failed';

export type ArtifactAvailability = {
  /**
   * Whether the transcript should render a card for this artifact. Reactive: reading it from a
   * tracked scope subscribes to probe results. Embeddable artifacts are always visible; path
   * candidates stay hidden until the host confirms the file exists.
   */
  isVisible(artifact: TranscriptArtifact): boolean;
  /** Re-probe missing and failed artifacts (the agent may have created them; the host may be back). */
  invalidateMissing(): void;
  dispose(): void;
};

/**
 * Per-chat availability cache for path-referenced artifacts. Text scanning promotes anything that
 * looks like a media path (source code, web paths), so the host decides whether it is a real file.
 */
export function createArtifactAvailability(
  getProbe: () => ChatCommands['artifactExists']
): ArtifactAvailability {
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  const controllers = new Set<AbortController>();
  const [version, setVersion] = createSignal(0);
  let inFlight = 0;
  let notifyScheduled = false;
  let disposed = false;

  // Each bump re-segments the whole transcript, so it fires only when a card appears or
  // disappears, and results arriving in a burst are coalesced.
  const notify = () => {
    if (notifyScheduled || disposed) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      if (!disposed) setVersion((v) => v + 1);
    });
  };

  const enqueue = (uri: string, entry: Entry) => {
    if (entry.probing) {
      entry.again = true;
      return;
    }
    entry.probing = true;
    queue.push(uri);
  };

  const pump = () => {
    const probe = getProbe();
    while (!disposed && inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const uri = queue.shift()!;
      const entry = entries.get(uri);
      if (!entry) continue;
      const controller = new AbortController();
      controllers.add(controller);
      inFlight += 1;
      const finish = (state: Entry['state']) => {
        controllers.delete(controller);
        inFlight -= 1;
        if (disposed || controller.signal.aborted) return;
        const wasShown = isShown(entry);
        entry.state = state;
        entry.probing = false;
        if (isShown(entry) !== wasShown) notify();
        if (entry.again) {
          entry.again = false;
          enqueue(uri, entry);
        }
        pump();
      };
      let result: Promise<boolean>;
      try {
        result = probe
          ? probe(entry.artifact, { signal: controller.signal })
          : Promise.reject(new Error('artifactExists unavailable'));
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        (exists) => finish(exists ? 'present' : 'missing'),
        () => finish('failed')
      );
    }
  };

  return {
    isVisible(artifact) {
      if (safeArtifactUrl(artifact.uri)) return true;
      version();
      if (!getProbe()) return true;
      let entry = entries.get(artifact.uri);
      if (!entry) {
        entry = { artifact, state: 'unknown', probing: false, again: false };
        entries.set(artifact.uri, entry);
        enqueue(artifact.uri, entry);
        // The probe must not subscribe the segmenting scope to whatever it reads.
        untrack(pump);
      }
      return isShown(entry);
    },
    invalidateMissing() {
      // Re-probe in place: visibility only changes (and re-segments) if an answer differs.
      for (const [uri, entry] of entries) {
        if (entry.state === 'missing' || entry.state === 'failed') enqueue(uri, entry);
      }
      pump();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
