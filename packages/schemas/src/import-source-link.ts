import { importUrlSchema } from './import.js';

/** Source links are navigation only; never publish signed queries, fragments or embedded credentials. */
export function importSourceLink(raw: unknown): string | null {
  const parsed = importUrlSchema.safeParse(raw);
  if (!parsed.success) return null;
  const url = new URL(parsed.data);
  url.search = '';
  url.hash = '';
  return url.toString();
}
