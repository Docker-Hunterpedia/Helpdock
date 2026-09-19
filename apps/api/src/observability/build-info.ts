import { readFileSync } from 'node:fs';
import type { SystemBuild } from '@helpdock/schemas';

/**
 * "Version + git sha" on the System page (ARCHITECTURE §14). Three facts an
 * operator needs before reporting anything: which release this is, which commit
 * it was built from, and which Node it is running on.
 *
 * The sha is baked at image build time from the `HELPDOCK_GIT_SHA` build
 * argument rather than read from `.git`, because the image has no `.git` and
 * shelling out to `git` from a running container is neither available nor
 * something a status endpoint should do.
 */

/** What the value reads as before an image build has baked one in. */
export const UNKNOWN_GIT_SHA = 'unknown';

/**
 * Short form, as a person quotes it. A build argument may be handed the full
 * 40-character sha, which is the same fact spelled longer.
 */
const SHORT_SHA_LENGTH = 7;

export const shortSha = (value: string | undefined): string => {
  const trimmed = value?.trim() ?? '';
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    // Anything that is not a sha — an empty build arg, a branch name, the
    // literal `$GIT_SHA` from a Dockerfile that did not substitute — is not
    // reported as if it were one.
    return UNKNOWN_GIT_SHA;
  }

  return trimmed.slice(0, SHORT_SHA_LENGTH).toLowerCase();
};

/**
 * `version` from the api's own `package.json`, read once. The path is the same
 * from `src/observability/` and from `dist/observability/`, both being one
 * directory below the package root's `src`/`dist`.
 *
 * At module load rather than per call: the System page polls every ten seconds
 * per open tab, and a synchronous file read on the event loop for a value that
 * cannot change while the process lives is a cost with no benefit.
 */
const VERSION: string = ((): string => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { readonly version?: string };

  return manifest.version ?? '0.0.0';
})();

export interface BuildInfoSource {
  readonly gitSha?: string | undefined;
  readonly nodeVersion?: string;
  readonly uptimeSeconds?: number;
}

export const buildInfo = ({
  gitSha = process.env.HELPDOCK_GIT_SHA,
  nodeVersion = process.version,
  uptimeSeconds = process.uptime(),
}: BuildInfoSource = {}): SystemBuild => ({
  version: VERSION,
  gitSha: shortSha(gitSha),
  nodeVersion,
  uptimeSeconds: Math.round(uptimeSeconds),
});
