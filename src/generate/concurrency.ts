export async function mapSettledLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (limit < 1) throw new Error(`concurrency limit must be >= 1, got ${limit}`);
  const settled: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        settled[index] = {
          status: "fulfilled",
          value: await fn(items[index]!, index),
        };
      } catch (error) {
        settled[index] = {
          status: "rejected",
          reason: error,
        };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return settled;
}
