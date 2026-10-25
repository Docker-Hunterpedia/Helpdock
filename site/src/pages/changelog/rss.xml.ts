import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { RELEASES, SITE_URL } from '../../data/site.ts';
import { releaseTimeline } from '../../lib/release-list.ts';
import { groupLabel } from '../../lib/release-notes.ts';

type Release = Awaited<ReturnType<typeof releaseTimeline>>[number]['release'];

function itemHtml(release: Release): string {
  if (release.source === 'tag') {
    return `<p>The notes are on the <a href="${RELEASES}/tag/v${release.version}">GitHub release</a>.</p>`;
  }
  const groups = release.groups.map((group) => {
    const items = group.items
      .map((item) => `<li>${item.lead ? `<strong>${item.lead}</strong> ` : ''}${item.body}</li>`)
      .join('');
    return `<h3>${groupLabel(group.heading)}</h3>${items ? `<ul>${items}</ul>` : ''}${group.paragraphs}`;
  });
  return `${release.intro}${groups.join('')}`;
}

export async function GET(context: APIContext) {
  const timeline = await releaseTimeline();
  return rss({
    title: 'Helpdock releases',
    description: 'Every Helpdock release, with what changed.',
    site: context.site ?? SITE_URL,
    items: timeline.map(({ release }) => ({
      title: `Helpdock ${release.version}`,
      link: `/changelog/${release.version}/`,
      ...(release.date ? { pubDate: new Date(release.date) } : {}),
      content: itemHtml(release),
    })),
    customData: '<language>en</language>',
  });
}
