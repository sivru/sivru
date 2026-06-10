// Bounded-concurrency async map. Order-preserving: `results[i]` corresponds to
// `items[i]`, regardless of completion order. Use to parallelize independent
// I/O (file reads, parses) without unbounded fan-out — N workers pull from a
// shared cursor until the items are exhausted.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workers = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
