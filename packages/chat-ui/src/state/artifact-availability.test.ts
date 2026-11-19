import { describe, expect, it, vi } from 'vitest';
import { createArtifactAvailability } from './artifact-availability';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  it('re-probes missing uris after invalidation and then shows them', async () => {
    let exists = false;
    const probe = vi.fn(async () => exists);
    const availability = createArtifactAvailability(() => probe);
    expect(availability.isVisible(art('/a.png'))).toBe(false);
    await tick();
    expect(availability.isVisible(art('/a.png'))).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    exists = true;
    availability.invalidateMissing();
    expect(availability.isVisible(art('/a.png'))).toBe(false);
    await tick();
    expect(availability.isVisible(art('/a.png'))).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
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
