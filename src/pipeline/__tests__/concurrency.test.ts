import { describe, it, expect } from 'vitest';
import { runWithConcurrency, startWithConcurrency } from '../concurrency.js';

describe('runWithConcurrency', () => {
  it('returns results in input order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];

    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('returns results in input order despite varying completion times', async () => {
    const tasks = [
      () => new Promise<string>((r) => setTimeout(() => r('slow'), 50)),
      () => Promise.resolve('fast'),
      () => new Promise<string>((r) => setTimeout(() => r('medium'), 20)),
    ];

    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual(['slow', 'fast', 'medium']);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const makeTask = (id: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return id;
    };

    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(i));
    const results = await runWithConcurrency(tasks, 3);

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles individual task failures gracefully', async () => {
    const tasks = [
      () => Promise.resolve('ok1'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('ok3'),
    ];

    const results = await runWithConcurrency(tasks, 3);

    expect(results[0]).toBe('ok1');
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toBe('fail');
    expect(results[2]).toBe('ok3');
  });

  it('handles all tasks failing', async () => {
    const tasks = [
      () => Promise.reject(new Error('fail1')),
      () => Promise.reject(new Error('fail2')),
    ];

    const results = await runWithConcurrency(tasks, 2);

    expect(results[0]).toBeInstanceOf(Error);
    expect(results[1]).toBeInstanceOf(Error);
  });

  it('handles empty task array', async () => {
    const results = await runWithConcurrency([], 3);
    expect(results).toEqual([]);
  });

  it('handles limit larger than task count', async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
    const results = await runWithConcurrency(tasks, 10);
    expect(results).toEqual([1, 2]);
  });

  it('handles non-Error rejections', async () => {
    const tasks = [() => Promise.reject('string error')];
    const results = await runWithConcurrency(tasks, 1);
    expect(results[0]).toBeInstanceOf(Error);
    expect((results[0] as Error).message).toBe('string error');
  });
});

describe('startWithConcurrency', () => {
  it('returns per-task promises that resolve individually', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ];

    const promises = startWithConcurrency(tasks, 3);
    expect(promises).toHaveLength(3);

    const results = await Promise.all(promises);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('resolves promises in completion order while maintaining index mapping', async () => {
    const order: number[] = [];
    const tasks = [
      () => new Promise<string>((r) => setTimeout(() => { order.push(0); r('slow'); }, 60)),
      () => new Promise<string>((r) => setTimeout(() => { order.push(1); r('fast'); }, 10)),
      () => new Promise<string>((r) => setTimeout(() => { order.push(2); r('medium'); }, 30)),
    ];

    const promises = startWithConcurrency(tasks, 3);

    // Await in index order — each resolves when its task finishes
    expect(await promises[0]).toBe('slow');
    expect(await promises[1]).toBe('fast');
    expect(await promises[2]).toBe('medium');

    // Tasks completed in speed order, not index order
    expect(order).toEqual([1, 2, 0]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const makeTask = (id: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return id;
    };

    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(i));
    const promises = startWithConcurrency(tasks, 2);

    const results = await Promise.all(promises);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles individual task failures without affecting others', async () => {
    const tasks = [
      () => Promise.resolve('ok1'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('ok3'),
    ];

    const promises = startWithConcurrency(tasks, 3);

    expect(await promises[0]).toBe('ok1');
    expect(await promises[1]).toBeInstanceOf(Error);
    expect((await promises[1] as Error).message).toBe('fail');
    expect(await promises[2]).toBe('ok3');
  });

  it('allows awaiting early promises while later tasks still run', async () => {
    const events: string[] = [];

    const tasks = [
      () => new Promise<string>((r) => setTimeout(() => { events.push('done-0'); r('a'); }, 10)),
      () => new Promise<string>((r) => setTimeout(() => { events.push('done-1'); r('b'); }, 80)),
    ];

    const promises = startWithConcurrency(tasks, 2);

    // Await first result — should resolve quickly
    const first = await promises[0];
    expect(first).toBe('a');
    expect(events).toEqual(['done-0']); // second task still running

    // Now await second
    const second = await promises[1];
    expect(second).toBe('b');
    expect(events).toEqual(['done-0', 'done-1']);
  });

  it('handles empty task array', () => {
    const promises = startWithConcurrency([], 3);
    expect(promises).toEqual([]);
  });

  it('starts new tasks as earlier ones complete', async () => {
    const started: number[] = [];

    const makeTask = (id: number, delay: number) => async () => {
      started.push(id);
      await new Promise((r) => setTimeout(r, delay));
      return id;
    };

    // limit=2: tasks 0,1 start immediately; task 2 starts when one finishes
    const tasks = [
      makeTask(0, 30),
      makeTask(1, 10), // finishes first → triggers task 2
      makeTask(2, 10),
    ];

    const promises = startWithConcurrency(tasks, 2);

    // Wait briefly for initial tasks to start
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual([0, 1]); // only 2 started (limit)

    await Promise.all(promises);
    expect(started).toEqual([0, 1, 2]); // task 2 started after task 1 finished
  });
});
