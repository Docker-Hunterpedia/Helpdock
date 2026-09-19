import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the admin build lives and which file a request maps to. Pure path
 * arithmetic and one `stat`, kept away from the controller so the rules can be
 * proved without a server.
 */

/** The file Vite emits, and the one every unknown path falls back to. */
export const INDEX_FILE = 'index.html';

/** Directory Vite hashes its output into. Everything in it is content-addressed. */
const HASHED_DIRECTORY = 'assets';

const ONE_YEAR_SECONDS = 31_536_000;
const ONE_HOUR_SECONDS = 3600;

/**
 * The absolute admin build directory, or `undefined` when there is none. A
 * checkout that has not run `pnpm build` and a dev loop that serves the SPA from
 * Vite are both this case: the api still boots and still serves `/api`, and the
 * caller logs once that the SPA is not being served.
 */
export const resolveAdminDist = (configured: string): string | undefined => {
  const directory = path.resolve(configured);
  return existsSync(path.join(directory, INDEX_FILE)) ? directory : undefined;
};

/**
 * True for a path the api owns rather than the SPA. `/api/does-not-exist` has to
 * answer 404 as JSON; answering with `index.html` would hand a client a page
 * where it asked for data, and a fetch would parse HTML as a response body.
 */
export const isApiPath = (pathname: string): boolean =>
  pathname === '/api' || pathname.startsWith('/api/');

/**
 * The path a request names, or `undefined` when it cannot be a file name. A
 * malformed escape and an embedded NUL both land here rather than at the file
 * system.
 */
const decodePathname = (pathname: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
};

/** True when `target` is still under `root` once every symbolic link is followed. */
const isInside = (root: string, target: string): boolean => {
  try {
    return realpathSync(target).startsWith(realpathSync(root) + path.sep);
  } catch {
    return false;
  }
};

/**
 * The file inside the build a request asks for, relative to the build root, or
 * `undefined` when the request is not for one. `undefined` is the SPA fallback:
 * `/tickets/42` is a client-side route, not a missing file.
 *
 * Two ways out of the build are closed here: a `..` segment, which normalises
 * to a path outside the root, and a symbolic link that resolves outside it.
 */
export const resolveAssetPath = (root: string, pathname: string): string | undefined => {
  const decoded = decodePathname(pathname);
  if (decoded === undefined) {
    return undefined;
  }

  const relative = path.normalize(decoded).replace(/^[/\\]+/, '');
  const absolute = path.resolve(root, relative);
  // `path.join` re-normalises, so a `relative` that climbed out of the root no
  // longer matches what `resolve` produced from it.
  if (relative === '' || absolute !== path.join(root, relative)) {
    return undefined;
  }

  if (statSync(absolute, { throwIfNoEntry: false })?.isFile() !== true) {
    return undefined;
  }

  return isInside(root, absolute) ? relative : undefined;
};

/**
 * `Cache-Control` for a file of the build.
 *
 * `index.html` names the hashed bundles and carries the rewritten install meta
 * tags, so it must never be reused: a stale copy points at bundles a deploy has
 * already removed. Everything under `assets/` has its content hash in its name,
 * so it can be kept for a year and never revalidated. The rest — the favicon,
 * anything copied from `public/` — is neither, so it gets an hour.
 */
export const cacheControlFor = (relativePath: string): string => {
  if (relativePath === INDEX_FILE) {
    return 'no-store';
  }

  const [first] = relativePath.split(path.sep);
  return first === HASHED_DIRECTORY
    ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
    : `public, max-age=${ONE_HOUR_SECONDS}`;
};
