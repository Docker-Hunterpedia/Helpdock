import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A directory that exists for the length of one job and is removed whatever
 * happens inside it.
 *
 * Every temporary file the media pipeline writes lives in one of these, with a
 * name this process chose. Three things follow, and each one is a rule the
 * upload path would otherwise have to defend itself against:
 *
 * - **Nothing a stranger named reaches the filesystem.** Paths are built from
 *   the variant names in `variants.ts`, so a filename containing `../`, a NUL
 *   byte or a leading `-` that a tool would read as a flag cannot become a
 *   path.
 * - **`mkdtemp` is exclusive.** The directory did not exist a moment ago and
 *   belongs to this process, so two jobs cannot collide and nothing can be
 *   pre-created by somebody else with a symlink in it.
 * - **The cleanup is in a `finally`.** A worker that rejected a 50 MB video
 *   must not leave it behind; a disk that fills is a worker that stops.
 */
export const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-media-'));

  try {
    return await run(dir);
  } finally {
    // `force` so a job that already removed a file does not fail its own
    // cleanup, and never `throw`: losing a temporary directory is worth a log
    // line, not a retry of work that succeeded.
    await rm(dir, { recursive: true, force: true });
  }
};
