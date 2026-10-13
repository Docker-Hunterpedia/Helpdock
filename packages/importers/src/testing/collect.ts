/** Collect only small test fixtures; runtime imports consume the iterator page by page. */
export async function collectAsync<T>(entries: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const entry of entries) collected.push(entry);
  return collected;
}
