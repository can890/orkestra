import { safeArtifactUrl } from '@lib/artifact-references';
import type { TranscriptArtifact } from '@orkestra/core/runtimes/acp/api/client';
import { createSignal, untrack } from 'solid-js';
import type { ChatCommands } from '../commands';

/** Concurrent probes in flight; each one can be an SSH round trip. */
const MAX_IN_FLIGHT = 4;

type Entry =
  | { state: 'pending' }
  | { state: 'present' }
  | { state: 'missing' }
  // The probe itself failed (connection down, ...): show the card so a real output never
  // vanishes; the card's own error then explains the problem.
  | { state: 'failed' };

export type ArtifactAvailability = {
  /**
   * Whether the transcript should render a card for this artifact. Reactive: reading it from a
   * tracked scope subscribes to probe results. Embeddable artifacts are always visible; path
   * candidates stay hidden until the host confirms the file exists.
   */
  isVisible(artifact: TranscriptArtifact): boolean;
  /** Re-probe artifacts that were reported missing (the agent may have created them since). */
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
  const queue: Array<{ artifact: TranscriptArtifact; uri: string }> = [];
  const controllers = new Set<AbortController>();
  const [version, setVersion] = createSignal(0);
  let inFlight = 0;
  let notifyScheduled = false;
  let disposed = false;

  // Probe results arrive in bursts; coalesce so the transcript re-segments once per burst.
  const notify = () => {
    if (notifyScheduled || disposed) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      if (!disposed) setVersion((v) => v + 1);
    });
  };

  const pump = () => {
    const probe = getProbe();
    while (!disposed && inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const job = queue.shift()!;
      const controller = new AbortController();
      controllers.add(controller);
      inFlight += 1;
      const finish = (entry: Entry) => {
        controllers.delete(controller);
        inFlight -= 1;
        if (disposed || controller.signal.aborted) return;
        entries.set(job.uri, entry);
        notify();
        pump();
      };
      let result: Promise<boolean>;
      try {
        result = probe
          ? probe(job.artifact, { signal: controller.signal })
          : Promise.reject(new Error('artifactExists unavailable'));
      } catch (error) {
        result = Promise.reject(error);
      }
      void result.then(
        (exists) => finish({ state: exists ? 'present' : 'missing' }),
        () => finish({ state: 'failed' })
      );
    }
  };

  return {
    isVisible(artifact) {
      if (safeArtifactUrl(artifact.uri)) return true;
      version();
      if (!getProbe()) return true;
      const entry = entries.get(artifact.uri);
      if (!entry) {
        entries.set(artifact.uri, { state: 'pending' });
        queue.push({ artifact, uri: artifact.uri });
        // The probe must not subscribe the segmenting scope to whatever it reads.
        untrack(pump);
        return false;
      }
      return entry.state === 'present' || entry.state === 'failed';
    },
    invalidateMissing() {
      let changed = false;
      for (const [uri, entry] of entries) {
        if (entry.state === 'missing') {
          entries.delete(uri);
          changed = true;
        }
      }
      // The next read re-registers and re-probes each uri.
      if (changed) notify();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}
