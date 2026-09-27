import type {
  HcAccess,
  HcArticleLookup,
  HcAudience,
  HcLocale,
  HcSitemapEntry,
  HcTreeCategory,
} from '@helpdock/schemas';

/**
 * A help center held in memory, for the pages' unit suite and the Playwright
 * server (`apps/api/e2e/help-center-server.ts`), which drive `HelpCenterSite`
 * without a database. It answers the `SiteContent` questions with the same
 * rules the SQL read side applies (DOMAIN-RULES §5): a visitor reads
 * published, public versions of a help center that is not internal-only;
 * staff read every published version; a missing language falls back to the
 * brand's default.
 *
 * Type imports and packages only, so node can run it straight from source.
 */

export const HC_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
export const HC_OTHER_BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b2';

interface Version {
  readonly locale: HcLocale;
  readonly status: 'draft' | 'published' | 'archived' | 'scheduled';
  readonly visibility: 'public' | 'internal';
  readonly title: string;
  readonly description: string;
  readonly bodyHtml: string;
}

interface Article {
  readonly id: string;
  readonly slug: string;
  readonly sectionId: string;
  readonly versions: readonly Version[];
}

interface Section {
  readonly id: string;
  readonly slug: string;
  readonly names: { en: string; ar: string };
}

interface Category {
  readonly id: string;
  readonly slug: string;
  readonly names: { en: string; ar: string };
  readonly descriptions: { en: string; ar: string };
  readonly sections: readonly Section[];
}

const id = (n: number): string => `0192c3f0-1a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

const published = (
  locale: HcLocale,
  title: string,
  body: string,
  visibility: 'public' | 'internal' = 'public',
): Version => ({
  locale,
  status: 'published',
  visibility,
  title,
  description: `${title}.`,
  bodyHtml: body,
});

export const CATEGORIES: readonly Category[] = [
  {
    id: id(100),
    slug: 'returns-and-refunds',
    names: { en: 'Returns & refunds', ar: 'الإرجاع والاسترداد' },
    descriptions: {
      en: 'Starting a return, what it costs, and when your money comes back.',
      ar: 'بدء الإرجاع وتكلفته وموعد استرداد أموالك.',
    },
    sections: [
      {
        id: id(110),
        slug: 'starting-a-return',
        names: { en: 'Starting a return', ar: 'بدء الإرجاع' },
      },
      { id: id(111), slug: 'refunds', names: { en: 'Refunds', ar: 'المبالغ المستردة' } },
    ],
  },
  {
    id: id(200),
    slug: 'orders',
    names: { en: 'Orders', ar: 'الطلبات' },
    descriptions: {
      en: 'Tracking, changing and cancelling orders.',
      ar: 'تتبع الطلبات وتعديلها وإلغاؤها.',
    },
    sections: [{ id: id(210), slug: 'tracking', names: { en: 'Tracking', ar: 'التتبع' } }],
  },
];

export const ARTICLES: Article[] = [
  {
    id: id(1),
    slug: 'refund-timelines',
    sectionId: id(111),
    versions: [
      published(
        'en',
        'Refund timelines',
        '<p>Once we receive your return, we issue the refund.</p><table><thead><tr><th>Method</th><th>Time</th></tr></thead><tbody><tr><td>Card</td><td>3–5 days</td></tr></tbody></table><div data-callout="tip"><p>Count business days from the refund email.</p></div><h2 id="longer">If it has been longer</h2><p>Check with your bank, then <a href="/en/articles/how-to-start-a-return">start a return</a>.</p><div data-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></div>',
      ),
      published(
        'ar',
        'مواعيد استرداد المبلغ',
        '<p>بعد أن نستلم المنتج المُرجَع، نُصدر المبلغ المسترد.</p><pre dir="ltr"><code>Refund reference: RF-2026-004817</code></pre>',
      ),
    ],
  },
  {
    id: id(2),
    slug: 'how-to-start-a-return',
    sectionId: id(110),
    versions: [
      published('en', 'How to start a return', '<p>Open your order and choose Return.</p>'),
    ],
  },
  {
    id: id(3),
    slug: 'approving-large-refunds',
    sectionId: id(111),
    versions: [
      published(
        'en',
        'Approving large refunds',
        '<p>Team leads approve refunds over 500 SAR.</p>',
        'internal',
      ),
    ],
  },
  {
    id: id(4),
    slug: 'returning-sale-items',
    sectionId: id(110),
    versions: [
      { ...published('en', 'Returning items bought on sale', '<p>Old.</p>'), status: 'archived' },
    ],
  },
  {
    id: id(5),
    slug: 'where-is-my-order',
    sectionId: id(210),
    versions: [
      published('en', 'Where is my order?', '<p>Track it from your account.</p>'),
      published('ar', 'أين طلبي؟', '<p>تتبعه من حسابك.</p>'),
    ],
  },
  {
    id: id(6),
    slug: 'exchanging-a-gift',
    sectionId: id(110),
    versions: [{ ...published('en', 'Exchanging a gift', '<p>Draft text.</p>'), status: 'draft' }],
  },
];

export interface MemorySiteOptions {
  access?: HcAccess;
  widgetOrigins?: readonly string[];
  customCss?: string;
}

const readable = (version: Version, audience: HcAudience, access: HcAccess): boolean =>
  version.status === 'published' &&
  (audience === 'internal' || (version.visibility === 'public' && access === 'public'));

const pick = (
  article: Article,
  audience: HcAudience,
  access: HcAccess,
  locale: HcLocale,
): Version | undefined => {
  const open = article.versions.filter((version) => readable(version, audience, access));
  return (
    open.find((version) => version.locale === locale) ??
    open.find((version) => version.locale === 'en')
  );
};

const sectionOf = (sectionId: string) => {
  for (const category of CATEGORIES) {
    const section = category.sections.find((candidate) => candidate.id === sectionId);
    if (section !== undefined) {
      return { category, section };
    }
  }
  throw new Error(`no section ${sectionId}`);
};

/** A `SiteContent` over the arrays above; the brand's options change per test. */
export const memorySiteContent = (options: MemorySiteOptions = {}) => {
  const state = { access: options.access ?? 'public' } as { access: HcAccess };

  const tree = ({
    brandId,
    audience,
    locale,
  }: {
    brandId: string;
    audience: HcAudience;
    locale: HcLocale;
  }): Promise<HcTreeCategory[]> => {
    if (brandId !== HC_BRAND) {
      return Promise.resolve([]);
    }
    const categories = CATEGORIES.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.names[locale],
      description: category.descriptions[locale],
      sections: category.sections
        .map((section) => ({
          id: section.id,
          slug: section.slug,
          name: section.names[locale],
          articles: ARTICLES.filter((article) => article.sectionId === section.id).flatMap(
            (article) => {
              const version = pick(article, audience, state.access, locale);
              return version === undefined
                ? []
                : [
                    {
                      id: article.id,
                      slug: article.slug,
                      title: version.title,
                      locale: version.locale,
                      fallback: version.locale !== locale,
                    },
                  ];
            },
          ),
        }))
        .filter((section) => section.articles.length > 0),
    })).filter((category) => category.sections.length > 0);
    return Promise.resolve(categories);
  };

  const article = ({
    brandId,
    audience,
    locale,
    slug,
  }: {
    brandId: string;
    audience: HcAudience;
    locale: HcLocale;
    slug: string;
  }): Promise<HcArticleLookup> => {
    const found =
      brandId === HC_BRAND ? ARTICLES.find((candidate) => candidate.slug === slug) : undefined;
    if (found === undefined) {
      return Promise.resolve({ state: 'not_found' });
    }
    const version = pick(found, audience, state.access, locale);
    if (version === undefined) {
      const archived = found.versions.some(
        (candidate) =>
          candidate.status === 'archived' &&
          (audience === 'internal' ||
            (candidate.visibility === 'public' && state.access === 'public')),
      );
      return Promise.resolve(archived ? { state: 'gone' } : { state: 'not_found' });
    }
    const { category, section } = sectionOf(found.sectionId);
    return Promise.resolve({
      state: 'found',
      article: {
        id: found.id,
        slug: found.slug,
        locale: version.locale,
        fallback: version.locale !== locale,
        visibility: version.visibility,
        title: version.title,
        description: version.description,
        bodyHtml: version.bodyHtml,
        publishedAt: '2026-09-12T09:00:00.000Z',
        locales: found.versions
          .filter((candidate) => readable(candidate, audience, state.access))
          .map((candidate) => candidate.locale),
        section: { id: section.id, slug: section.slug, name: section.names[locale] },
        category: { id: category.id, slug: category.slug, name: category.names[locale] },
      },
    });
  };

  const sitemap = (brandId: string): Promise<HcSitemapEntry[]> =>
    Promise.resolve(
      brandId !== HC_BRAND
        ? []
        : ARTICLES.flatMap((candidate) => {
            const locales = candidate.versions
              .filter((version) => readable(version, 'public', state.access))
              .map((version) => version.locale);
            return locales.map((locale) => ({
              slug: candidate.slug,
              locale,
              lastModified: '2026-09-12T09:00:00.000Z',
              alternates: locales,
            }));
          }),
    );

  return {
    state,
    content: {
      config: (brandId: string) =>
        Promise.resolve(
          brandId !== HC_BRAND
            ? null
            : {
                brandId: HC_BRAND,
                brandName: 'Helpdock',
                defaultLocale: 'en' as const,
                timezone: 'Asia/Riyadh',
                access: state.access,
                theme: {
                  accent: '#0F766E',
                  surfaceTone: 'warm' as const,
                  radius: 6,
                  mode: 'auto' as const,
                  font: 'ibm-plex' as const,
                },
                logo: null,
                favicon: null,
                home: {
                  categories: true,
                  featured: true,
                  featuredArticleIds: [id(1), id(5)],
                  popular: true,
                },
                links: {
                  header: [
                    {
                      labelEn: 'Main site',
                      labelAr: 'الموقع الرئيسي',
                      url: 'https://www.example.com',
                    },
                  ],
                  footer: [
                    {
                      labelEn: 'Privacy',
                      labelAr: 'الخصوصية',
                      url: 'https://www.example.com/privacy',
                    },
                  ],
                },
                customCss: options.customCss ?? '',
                widgetOrigins: options.widgetOrigins ?? [],
                primaryDomain: null,
              },
        ),
      tree,
      article,
      sitemap,
      gone: (_brandId: string, scope: { locale: HcLocale }, slug: string) => {
        const found = ARTICLES.find((candidate) => candidate.slug === slug);
        const version = found?.versions.find((candidate) => candidate.status === 'archived');
        return Promise.resolve(
          found === undefined || version === undefined
            ? null
            : {
                title: version.title,
                locale: version.locale,
                retiredAt: new Date('2026-09-03T10:00:00Z'),
                sectionId: found.sectionId,
                sectionName: sectionOf(found.sectionId).section.names[scope.locale],
              },
        );
      },
      preview: (_brandId: string, scope: { locale: HcLocale }, slug: string) => {
        const found = ARTICLES.find((candidate) => candidate.slug === slug);
        const version = found?.versions.find((candidate) => candidate.locale === scope.locale);
        if (found === undefined || version === undefined) {
          return Promise.resolve(null);
        }
        const { category, section } = sectionOf(found.sectionId);
        return Promise.resolve({
          id: found.id,
          slug: found.slug,
          locale: version.locale,
          state:
            version.status === 'published'
              ? ('published' as const)
              : version.status === 'scheduled'
                ? ('scheduled' as const)
                : version.status,
          visibility: version.visibility,
          title: version.title,
          description: version.description,
          bodyHtml: version.bodyHtml,
          scheduledAt: null,
          publishedAt: null,
          updatedAt: new Date('2026-09-20T08:00:00Z'),
          section: { id: section.id, slug: section.slug, name: section.names[scope.locale] },
          category: { id: category.id, slug: category.slug, name: category.names[scope.locale] },
        });
      },
    },
  };
};

export const articleId = id;
