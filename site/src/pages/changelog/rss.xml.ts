import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { RELEASES } from '../../data/site.ts';
import { compareReleasesDescending } from '../../lib/version.ts';

export async function GET(context: APIContext) {
  const releases = (await getCollection('releases')).sort((a, b) =>
    compareReleasesDescending(a.data.version, b.data.version),
  );
  return rss({
    title: 'Helpdock releases',
    description: 'Every Helpdock release, with what changed.',
    site: context.site ?? 'https://helpdock.oday-bakkour.com',
    items: releases.map((release) => ({
      title: `Helpdock ${release.data.version}`,
      link: `/changelog/#v${release.data.version}`,
      ...(release.data.date ? { pubDate: new Date(release.data.date) } : {}),
      content:
        release.data.source === 'tag'
          ? `<p>The notes are on the <a href="${RELEASES}/tag/v${release.data.version}">GitHub release</a>.</p>`
          : release.rendered?.html,
    })),
    customData: '<language>en</language>',
  });
}
