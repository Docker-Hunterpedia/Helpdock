const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The release number the site shows. The Pages workflow passes the latest
 * published, non-prerelease Release as `HELPDOCK_VERSION`; a local build falls
 * back to the `@helpdock/api` package version. A value that is set but is not a
 * plain x.y.z fails the build rather than publish a wrong number.
 */
export function resolveVersion(fromEnv: string | undefined, packageVersion: string): string {
  if (fromEnv !== undefined) {
    const version = fromEnv.trim().replace(/^v/, '');
    if (!SEMVER.test(version)) {
      throw new Error(`HELPDOCK_VERSION is "${fromEnv}", which is not a plain x.y.z release`);
    }
    return version;
  }
  if (!SEMVER.test(packageVersion)) {
    throw new Error(`the @helpdock/api version "${packageVersion}" is not a plain x.y.z release`);
  }
  return packageVersion;
}

export function isPlainRelease(version: string): boolean {
  return SEMVER.test(version);
}

/** Newest first. Both arguments must be plain x.y.z. */
export function compareReleasesDescending(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
