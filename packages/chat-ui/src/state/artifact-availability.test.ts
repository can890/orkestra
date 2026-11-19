import { createEffect, createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_DELAY_MS, createArtifactAvailability } from './artifact-availability';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Lets probe answers land and the coalesced notification fire. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, NOTIFY_DELAY_MS + 10));
const art = (uri: string) => ({ uri, name: uri });

describe('artifact availability', () => {
  it('caps probes in flight and drains the queue as they settle', async () => {
    const resolvers: Array<(exists: boolean) => void> = [];
    const probe = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)));
    const availability = createArtifactAvailability(() => probe);
    for (let i = 0; i < 10; i++) availability.isVisible(art(`/a/${i}.png`));
    expect(probe).toHaveBeenCalledTimes(4);
    resolvers.splice(0).forEach((resolve) => resolve(true));
    await tick();
    expect(probe).toHaveBeenCalledTimes(8);
    availability.dispose();
  });

  // Counts how often a tracked scope reading isVisible re-runs (each run = a transcript rebuild).
  function track(availability: ReturnType<typeof createArtifactAvailability>, uri: string) {
    const seen: boolean[] = [];
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        seen.push(availability.isVisible(art(uri)));
      });
      return dispose;
    });
    return { seen, dispose };
  }

  it('does not notify when a hidden entry lands as missing, nor on a missing re-probe', async () => {
    const probe = vi.fn(async () => false);
    const availability = createArtifactAvailability(() => probe);
    const { seen, dispose } = track(availability, '/a.png');
    await settle();
    expect(probe).toHaveBeenCalledOnce();
    expect(seen).toEqual([false]);
    availability.invalidateMissing();
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([false]);
    dispose();
    availability.dispose();
  });

  it('notifies when a hidden entry becomes present, including after a re-probe', async () => {
    let exists = false;
    const probe = vi.fn(async () => exists);
    const availability = createArtifactAvailability(() => probe);
    const { seen, dispose } = track(availability, '/a.png');
    await settle();
    exists = true;
    availability.invalidateMissing();
    await settle();
    expect(seen).toEqual([false, true]);
    dispose();
    availability.dispose();
  });

  it('notifies when pending resolves present', async () => {
    const availability = createArtifactAvailability(() => async () => true);
    const { seen, dispose } = track(availability, '/a.png');
    await settle();
    expect(seen).toEqual([false, true]);
    dispose();
    availability.dispose();
  });

  it('keeps failed entries visible while re-probing and hides them on a definitive false', async () => {
    let answer: () => Promise<boolean> = async () => {
      throw new Error('down');
    };
    const availability = createArtifactAvailability(() => () => answer());
    const { seen, dispose } = track(availability, '/a.png');
    await settle();
    expect(seen).toEqual([false, true]);
    let release!: (exists: boolean) => void;
    answer = () => new Promise<boolean>((resolve) => (release = resolve));
    availability.invalidateMissing();
    await settle();
    expect(availability.isVisible(art('/a.png'))).toBe(true);
    expect(seen).toEqual([false, true]);
    release(false);
    await settle();
    expect(seen).toEqual([false, true, false]);
    dispose();
    availability.dispose();
  });

  it('never runs two probes for one uri, even across an invalidation', async () => {
    const releases: Array<(exists: boolean) => void> = [];
    const probe = vi.fn(() => new Promise<boolean>((resolve) => releases.push(resolve)));
    const availability = createArtifactAvailability(() => probe);
    availability.isVisible(art('/a.png'));
    releases[0](false);
    await tick();
    availability.invalidateMissing();
    expect(probe).toHaveBeenCalledTimes(2);
    availability.invalidateMissing();
    expect(probe).toHaveBeenCalledTimes(2);
    releases[1](false);
    await tick();
    // The second invalidation arrived mid-flight, so exactly one follow-up probe runs.
    expect(probe).toHaveBeenCalledTimes(3);
    releases[2](false);
    await tick();
    expect(probe).toHaveBeenCalledTimes(3);
    availability.dispose();
  });

  it('aborts outstanding probes on dispose and ignores late answers', async () => {
    let signal: AbortSignal | undefined;
    let answer!: (exists: boolean) => void;
    const probe = vi.fn((_artifact, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<boolean>((resolve) => (answer = resolve));
    });
    const availability = createArtifactAvailability(() => probe);
    availability.isVisible(art('/a.png'));
    availability.dispose();
    expect(signal?.aborted).toBe(true);
    answer(true);
    await tick();
    expect(availability.isVisible(art('/a.png'))).toBe(false);
  });

  it('coalesces answers that land close together into one notification', async () => {
    const releases: Array<(exists: boolean) => void> = [];
    const availability = createArtifactAvailability(
      () => () => new Promise<boolean>((resolve) => releases.push(resolve))
    );
    let runs = 0;
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        runs += 1;
        availability.isVisible(art('/a.png'));
        availability.isVisible(art('/b.png'));
        availability.isVisible(art('/c.png'));
      });
      return dispose;
    });
    releases[0](true);
    await tick();
    releases[1](true);
    await tick();
    releases[2](true);
    await settle();
    expect(runs).toBe(2);
    dispose();
    availability.dispose();
  });

  it('does not re-run tracked readers when the host replaces its probe', async () => {
    const [probe, setProbe] = createSignal(async () => false);
    const availability = createArtifactAvailability(probe);
    const { seen, dispose } = track(availability, '/a.png');
    await settle();
    setProbe(() => async () => false);
    await settle();
    expect(seen).toEqual([false]);
    dispose();
    availability.dispose();
  });

  it('treats synchronous probe throws like rejections', async () => {
    const availability = createArtifactAvailability(() => () => {
      throw new Error('boom');
    });
    expect(availability.isVisible(art('/a.png'))).toBe(false);
    await tick();
    expect(availability.isVisible(art('/a.png'))).toBe(true);
    availability.dispose();
  });
});
