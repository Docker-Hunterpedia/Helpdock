import { getCollection } from 'astro:content';
import { releaseStep } from './release-notes.ts';
import { compareReleasesDescending } from './version.ts';

/** Every release newest first, each with its semver step from the one before it. */
export async function releaseTimeline() {
  const releases = (await getCollection('releases'))
    .map((entry) => entry.data)
    .sort((a, b) => compareReleasesDescending(a.version, b.version));
  return releases.map((release, index) => ({
    release,
    latest: index === 0,
    step: releaseStep(release.version, releases[index + 1]?.version),
  }));
}
