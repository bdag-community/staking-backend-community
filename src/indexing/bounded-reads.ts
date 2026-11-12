/** Bound in-flight RPC reads while retaining canonical block order. */
export async function mapBounded<T, U>(items: T[], concurrency: number, operation: (item: T) => Promise<U>): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid read concurrency');
  const output: U[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await operation(items[index]);
    }
  }));
  return output;
}
