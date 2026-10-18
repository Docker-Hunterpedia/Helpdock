/** Equal report entries are interchangeable; unrelated insertions must not change their keys. */
export function occurrenceKeys<T>(entries: readonly T[], identity: (entry: T) => string) {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    const base = identity(entry);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: JSON.stringify([base, occurrence]), entry };
  });
}
