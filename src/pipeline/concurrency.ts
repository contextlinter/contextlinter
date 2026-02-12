/**
 * Run async tasks with a concurrency limit.
 * Returns results in input order. Failed tasks return their Error.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<T | Error>> {
  const results: Array<T | Error> = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        results[index] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => runNext(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Start async tasks with a concurrency limit, returning per-task promises.
 *
 * Unlike `runWithConcurrency` which waits for ALL tasks before returning,
 * this returns an array of promises — one per task — that resolve individually
 * as each task completes. The caller can `await promises[i]` to get the result
 * of task i as soon as it's ready, while later tasks continue in the background.
 *
 * This enables interleaving: e.g. start suggesting for session 1 while
 * sessions 2 and 3 are still being analyzed.
 */
export function startWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Array<Promise<T | Error | null>> {
  const resolvers: Array<(value: T | Error | null) => void> = [];
  const promises = tasks.map<Promise<T | Error | null>>(
    () => new Promise((resolve) => { resolvers.push(resolve); }),
  );

  let nextIdx = 0;

  function startNext(): void {
    if (nextIdx >= tasks.length) return;
    const idx = nextIdx++;
    tasks[idx]()
      .then((result) => resolvers[idx](result))
      .catch((err) => resolvers[idx](err instanceof Error ? err : new Error(String(err))))
      .finally(() => startNext());
  }

  const initial = Math.min(limit, tasks.length);
  for (let i = 0; i < initial; i++) {
    startNext();
  }

  return promises;
}
