import { AUTHOR, REPO, SITE_URL } from '../data/site.ts';
import { plainText } from './inline-links.ts';

export type Crumb = { name: string; href: string };
export type Qa = { q: string; a: string };

export const absolute = (path: string) => new URL(path, SITE_URL).href;

export function breadcrumbList(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absolute(crumb.href),
    })),
  };
}

/** Links in an answer become plain text: the JSON-LD carries no markup. */
export function faqPage(items: Qa[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: plainText(item.a) },
    })),
  };
}

export function softwareApplication(input: { version: string; description: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Helpdock',
    url: absolute('/'),
    description: input.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Linux (Docker Compose)',
    softwareVersion: input.version,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isAccessibleForFree: true,
    inLanguage: ['en', 'ar'],
    image: absolute('/assets/img/og.png'),
    screenshot: absolute('/assets/img/ticket-view-en.webp'),
    downloadUrl: `${REPO}/releases/tag/v${input.version}`,
    releaseNotes: absolute('/changelog/'),
    sameAs: REPO,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url },
  };
}

export function techArticle(input: { title: string; description: string; path: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: input.title,
    description: input.description,
    url: absolute(input.path),
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'Helpdock', url: absolute('/') },
    author: { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url },
  };
}

/** `</script>` inside a string must not end the JSON-LD block it is written into. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c');
}
