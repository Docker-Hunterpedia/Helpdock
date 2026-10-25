/**
 * What the 404 page offers for an address that does not exist: the closest
 * known routes ("did you mean") and search words taken from the path.
 */

/** Path segments that name a section, not what the reader was after. */
const SECTIONS = new Set([
  'ar',
  'docs',
  'channels',
  'features',
  'compare',
  'alternatives',
  'changelog',
]);

/** A malformed escape (`/%E0`) is a typed address too: read it as written. */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch (error) {
    if (error instanceof URIError) return path;
    throw error;
  }
}

const segmentsOf = (path: string) =>
  decoded(path)
    .toLowerCase()
    .replace(/\.(html|md)$/, '')
    .split('/')
    .filter(Boolean);

/** `/docs/telgram-bot` → `telgram bot`. */
export function queryFromPath(path: string): string {
  return segmentsOf(path)
    .filter((segment) => !SECTIONS.has(segment))
    .flatMap((segment) => segment.split(/[-_.+]+/))
    .filter(Boolean)
    .join(' ');
}

/** Levenshtein distance, two rows at a time. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

const similarity = (a: string, b: string) =>
  a === b ? 1 : 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);

/**
 * How alike a requested path and a route are, 0 to 1: the better of the whole
 * path and the last segment, so `/telegram` still finds `/channels/telegram/`.
 * A route in the other language scores lower.
 */
export function routeScore(path: string, route: string): number {
  const asked = segmentsOf(path);
  const known = segmentsOf(route);
  if (known.length === 0) return asked.length === 0 ? 1 : 0;
  const whole = similarity(asked.join('/'), known.join('/'));
  const last = similarity(asked.at(-1) ?? '', known.at(-1) ?? '');
  const sameLanguage = (asked[0] === 'ar') === (known[0] === 'ar');
  return Math.max(whole, last) * (sameLanguage ? 1 : 0.8);
}

/** The closest routes to a missing path, best first, if any is close enough. */
export function suggestRoutes(
  path: string,
  routes: string[],
  limit = 2,
  threshold = 0.6,
): string[] {
  return routes
    .map((route) => ({ route, score: routeScore(path, route) }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((a, b) => b.score - a.score || a.route.length - b.route.length)
    .slice(0, limit)
    .map((candidate) => candidate.route);
}
