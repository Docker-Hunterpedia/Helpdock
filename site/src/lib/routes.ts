import { getCollection } from 'astro:content';
import { CHANNELS } from '../data/channels.ts';
import { COMPETITORS } from '../data/competitors.ts';
import { REFERENCE_PAGES } from '../data/docs.ts';
import { FEATURES } from '../data/features.ts';
import type { KnownRoute } from './suggest.ts';

const route = (path: string, title: string): KnownRoute => ({ path, title });

/** Every page a reader might have meant, for the 404 page's "did you mean". */
export async function knownRoutes(): Promise<KnownRoute[]> {
  const guides = await getCollection('guides');
  const releases = await getCollection('releases');
  return [
    route('/', 'Helpdock'),
    route('/ar/', 'Helpdock'),
    route('/channels/', 'Channels'),
    route('/ar/channels/', 'القنوات'),
    ...CHANNELS.flatMap((channel) => [
      route(`/channels/${channel.slug}/`, channel.en.name),
      route(`/ar/channels/${channel.slug}/`, channel.ar.name),
    ]),
    route('/features/', 'Features'),
    ...FEATURES.map((feature) => route(`/features/${feature.slug}/`, feature.name)),
    route('/compare/', 'Compare'),
    route('/ar/compare/', 'المقارنات'),
    ...COMPETITORS.flatMap((item) => [
      route(`/compare/helpdock-vs-${item.slug}/`, `Helpdock vs ${item.name}`),
      ...(item.ar ? [route(`/ar/compare/helpdock-vs-${item.slug}/`, item.name)] : []),
      ...(item.alternative
        ? [route(`/alternatives/${item.slug}/`, `${item.name} alternative`)]
        : []),
    ]),
    route('/docs/', 'Docs'),
    ...guides.map((guide) => route(`/docs/${guide.id}/`, guide.data.title)),
    ...REFERENCE_PAGES.map((page) => route(`/docs/${page.id}/`, page.title)),
    route('/changelog/', 'Changelog'),
    ...releases.map((release) => route(`/changelog/${release.id}/`, `Helpdock ${release.id}`)),
  ];
}
