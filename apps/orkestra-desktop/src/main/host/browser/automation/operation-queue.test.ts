import { describe, expect, it } from 'vitest';
import { OperationQueue } from './operation-queue';
import { delay } from './timing';

describe('OperationQueue', () => {
  it('runs tasks one at a time in submission order', async () => {
    const queue = new OperationQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await delay(ms);
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      queue.run(task('a', 20)),
      queue.run(task('b', 1)),
      queue.run(task('c', 5)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a failed task', async () => {
    const queue = new OperationQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok');
  });
});
