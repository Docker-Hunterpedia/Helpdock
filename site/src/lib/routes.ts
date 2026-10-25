import { getCollection } from 'astro:content';
import { CHANNELS } from '../data/channels.ts';
import { COMPETITORS } from '../data/competitors.ts';
import { REFERENCE_PAGES } from '../data/docs.ts';
import { FEATURES } from '../data/features.ts';

/** Every page a reader might have meant, for the 404 page's "did you mean". */
export async function knownRoutes(): Promise<string[]> {
  const guides = await getCollection('guides');
  const releases = await getCollection('releases');
  return [
    '/',
    '/ar/',
    '/channels/',
    '/ar/channels/',
    ...CHANNELS.flatMap((channel) => [
      `/channels/${channel.slug}/`,
      `/ar/channels/${channel.slug}/`,
    ]),
    '/features/',
    ...FEATURES.map((feature) => `/features/${feature.slug}/`),
    '/compare/',
    '/ar/compare/',
    ...COMPETITORS.flatMap((item) => [
      `/compare/helpdock-vs-${item.slug}/`,
      ...(item.ar ? [`/ar/compare/helpdock-vs-${item.slug}/`] : []),
      ...(item.alternative ? [`/alternatives/${item.slug}/`] : []),
    ]),
    '/docs/',
    ...guides.map((guide) => `/docs/${guide.id}/`),
    ...REFERENCE_PAGES.map((page) => `/docs/${page.id}/`),
    '/changelog/',
    ...releases.map((release) => `/changelog/${release.id}/`),
  ];
}
