import {
  HC_HOME_DEFAULTS,
  HC_THEME_DEFAULTS,
  type HcActivityAction,
  type HcActivityEntry,
  type HcAppearance,
  type HcAppearanceUpdateRequest,
  type HcArticle,
  type HcArticleCreateRequest,
  type HcArticleStatus,
  type HcArticleSummary,
  type HcArticleUpdateRequest,
  type HcCategory,
  type HcCategoryCreateRequest,
  type HcCategoryUpdateRequest,
  type HcCssRemoval,
  type HcCustomCssResult,
  type HcHomeLayout,
  type HcInsights,
  type HcInsightsQuery,
  type HcLinks,
  type HcLocale,
  type HcMedia,
  type HcMediaPresignRequest,
  type HcMediaPresignResponse,
  type HcReorderRequest,
  type HcSection,
  type HcSectionCreateRequest,
  type HcSectionUpdateRequest,
  type HcSettings,
  type HcSite,
  type HcStaffPassRequest,
  type HcStaffPassResponse,
  type HcStructure,
  type HcVersion,
  type HcVersionSaveRequest,
  type HcVersionStatusRequest,
  type HcVisibility,
  slugify,
} from '@helpdock/schemas';
import { MOCK_USER } from '../auth/mock-api.js';
import { type HelpCenterApi, HelpCenterError } from './api.js';

/**
 * The fixture behind the mock admin: the `Admin/HelpCenter` artboard's tree
 * and its Refunds section, down to the dashed Arabic chip, the scheduled
 * bundle article and the archived one. It keeps the api's rules — slugs,
 * "not empty", "was published", "in the past" — so a screen that handles a
 * refusal here handles the real one.
 */

const id = (n: number): string => `0193b000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const MOCK_HELP_CENTER = {
  categories: { orders: id(1), returns: id(2), account: id(3), shipping: id(4) },
  sections: {
    tracking: id(11),
    starting: id(21),
    refunds: id(22),
    damaged: id(23),
    signIn: id(31),
    delivery: id(41),
  },
  articles: {
    timelines: id(101),
    closedCard: id(102),
    bundles: id(103),
    restocking: id(104),
    exceptions: id(105),
    before2025: id(106),
    whereIsMyOrder: id(107),
  },
} as const;

const M = MOCK_HELP_CENTER;

/** The Insights board (`Admin/HelpCenter-Settings`, board 2), in numbers. */
const MOCK_TOP_SEARCHES: HcInsights['topSearches'] = [
  { query: 'refund', locale: 'en', searches: 412, openedRate: 0.68 },
  { query: 'track order', locale: 'en', searches: 305, openedRate: 0.74 },
  { query: 'cancel order', locale: 'en', searches: 188, openedRate: 0.61 },
  { query: 'change address', locale: 'en', searches: 141, openedRate: 0.55 },
  { query: 'invoice', locale: 'en', searches: 120, openedRate: 0.49 },
  { query: 'استرداد', locale: 'ar', searches: 96, openedRate: 0.58 },
];

const MOCK_ZERO_RESULT_SEARCHES: HcInsights['zeroResultSearches'] = [
  { query: 'klarna', locale: 'en', searches: 23, lastSearchedAt: '2026-09-26T15:10:00.000Z' },
  { query: 'gift wrap', locale: 'en', searches: 14, lastSearchedAt: '2026-09-25T09:00:00.000Z' },
  { query: 'تقسيط', locale: 'ar', searches: 9, lastSearchedAt: '2026-09-24T11:30:00.000Z' },
];

const MOCK_ARTICLE_STATS: HcInsights['articles'] = [
  {
    articleId: M.articles.timelines,
    title: 'Refund timelines',
    views: 2184,
    helpful: 212,
    votes: 246,
    comments: 9,
  },
  {
    articleId: M.articles.whereIsMyOrder,
    title: 'Where is my order?',
    views: 1902,
    helpful: 150,
    votes: 190,
    comments: 14,
  },
  {
    articleId: M.articles.restocking,
    title: 'Restocking fees',
    views: 1244,
    helpful: 88,
    votes: 124,
    comments: 0,
  },
  {
    articleId: M.articles.bundles,
    title: 'Returning part of a bundle',
    views: 406,
    helpful: 0,
    votes: 0,
    comments: 0,
  },
];
const OMAR = 'Omar Aziz';
const KARIM = 'Karim Saleh';

const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

interface Stored {
  article: { id: string; sectionId: string; slug: string; position: number };
  versions: HcVersion[];
  activity: HcActivityEntry[];
}

const version = (
  locale: HcLocale,
  title: string,
  status: HcArticleStatus,
  extra: Partial<HcVersion> = {},
): HcVersion => ({
  locale,
  status,
  visibility: 'public',
  title,
  description: '',
  bodyHtml: `<p>${title}</p>`,
  scheduledAt: null,
  publishedAt: status === 'draft' ? null : '2026-09-12T07:02:00.000Z',
  publishedByName: status === 'draft' ? null : MOCK_USER.name,
  updatedAt: '2026-09-12T07:02:00.000Z',
  updatedByName: MOCK_USER.name,
  hasUnpublishedChanges: false,
  ...extra,
});

const TIMELINES_EN = [
  '<p>Once we receive and inspect your return, we issue the refund to your original payment method. How long it takes to show depends on how you paid.</p>',
  '<h2 id="how-long">How long each method takes</h2>',
  '<table><tbody><tr><th><p>Payment method</p></th><th><p>After we issue the refund</p></th></tr>',
  '<tr><td><p>Credit or debit card</p></td><td><p>3–5 business days</p></td></tr>',
  '<tr><td><p>PayPal</p></td><td><p>Same day</p></td></tr></tbody></table>',
  '<div data-callout="tip"><p><strong>Tip.</strong> The refund email shows the date we issued it.</p></div>',
  '<pre><code>Refund reference: RF-2026-0911-8841</code></pre>',
].join('');

const seed = (): { categories: HcCategory[]; sections: HcSection[]; stored: Stored[] } => {
  const category = (key: keyof typeof M.categories, en: string, ar: string, position: number) => ({
    id: M.categories[key],
    slug: slugify(en, 'category'),
    names: { en, ar },
    descriptions: { en: '', ar: '' },
    position,
  });
  const section = (
    key: keyof typeof M.sections,
    categoryId: string,
    en: string,
    ar: string,
    position: number,
  ) => ({
    id: M.sections[key],
    categoryId,
    slug: slugify(en, 'section'),
    names: { en, ar },
    position,
  });
  const article = (
    key: keyof typeof M.articles,
    sectionId: string,
    position: number,
    versions: HcVersion[],
  ): Stored => ({
    article: {
      id: M.articles[key],
      sectionId,
      slug: slugify(versions[0]?.title ?? key, key),
      position,
    },
    versions,
    activity: [
      {
        id: id(900 + position),
        action: 'created',
        locale: 'en',
        actorName: MOCK_USER.name,
        at: '2026-09-02T06:12:00.000Z',
        detail: null,
      },
    ],
  });

  return {
    categories: [
      category('orders', 'Orders', 'الطلبات', 0),
      category('returns', 'Returns & refunds', 'المرتجعات والاسترداد', 1),
      category('account', 'Account', 'الحساب', 2),
      category('shipping', 'Shipping', 'الشحن', 3),
    ],
    sections: [
      section('tracking', M.categories.orders, 'Tracking', 'التتبع', 0),
      section('starting', M.categories.returns, 'Starting a return', 'بدء الإرجاع', 0),
      section('refunds', M.categories.returns, 'Refunds', 'المبالغ المستردة', 1),
      section('damaged', M.categories.returns, 'Damaged or wrong items', 'منتجات تالفة', 2),
      section('signIn', M.categories.account, 'Signing in', 'تسجيل الدخول', 0),
      section('delivery', M.categories.shipping, 'Delivery', 'التوصيل', 0),
    ],
    stored: [
      article('timelines', M.sections.refunds, 0, [
        version('en', 'Refund timelines', 'published', { bodyHtml: TIMELINES_EN }),
        version('ar', 'مواعيد استرداد المبالغ', 'scheduled', {
          publishedAt: null,
          publishedByName: null,
          scheduledAt: '2026-10-01T06:00:00.000Z',
          bodyHtml:
            '<p dir="rtl">بعد أن نستلم المرتجع ونفحصه، نعيد المبلغ إلى وسيلة الدفع الأصلية.</p>',
        }),
      ]),
      article('closedCard', M.sections.refunds, 1, [
        version('en', 'Refunds to a closed or expired card', 'published', {
          updatedByName: OMAR,
          updatedAt: '2026-09-10T13:40:00.000Z',
        }),
      ]),
      article('bundles', M.sections.refunds, 2, [
        version('en', 'Partial refunds for bundles', 'scheduled', {
          publishedAt: null,
          scheduledAt: '2026-10-01T06:00:00.000Z',
          updatedByName: KARIM,
          updatedAt: '2026-09-26T08:15:00.000Z',
        }),
        version('ar', 'استرداد جزئي للحزم', 'scheduled', {
          publishedAt: null,
          scheduledAt: '2026-10-01T06:00:00.000Z',
        }),
      ]),
      article('restocking', M.sections.refunds, 3, [
        version('en', 'How we calculate restocking fees', 'draft', {
          updatedAt: '2026-09-25T14:58:00.000Z',
        }),
      ]),
      article('exceptions', M.sections.refunds, 4, [
        version('en', 'Refund exceptions: who approves what', 'published', {
          visibility: 'internal',
          updatedByName: OMAR,
          updatedAt: '2026-09-20T06:31:00.000Z',
        }),
        version('ar', 'استثناءات الاسترداد', 'published', { visibility: 'internal' }),
      ]),
      article('before2025', M.sections.refunds, 5, [
        version('en', 'Refunds for orders before 2025', 'archived', {
          updatedAt: '2026-03-03T09:00:00.000Z',
        }),
        version('ar', 'استرداد الطلبات قبل 2025', 'archived'),
      ]),
      article('whereIsMyOrder', M.sections.tracking, 0, [
        version('en', 'Where is my order?', 'published'),
      ]),
    ],
  };
};

const summary = ({ article, versions }: Stored): HcArticleSummary => ({
  ...article,
  versions: versions.map(({ description: _d, bodyHtml: _b, publishedByName: _p, ...rest }) => rest),
});

export class MockHelpCenterApi implements HelpCenterApi {
  categories: HcCategory[];
  sections: HcSection[];
  stored: Stored[];
  #settings: HcSettings = { access: 'public' };
  #site: {
    appearance: HcAppearance;
    home: HcHomeLayout;
    links: HcLinks;
    customCss: string;
    url: string;
  } = {
    appearance: { theme: { ...HC_THEME_DEFAULTS }, logo: null, favicon: null },
    home: {
      ...HC_HOME_DEFAULTS,
      featured: true,
      featuredArticleIds: [
        MOCK_HELP_CENTER.articles.timelines,
        MOCK_HELP_CENTER.articles.whereIsMyOrder,
      ],
    },
    links: {
      header: [
        { labelEn: 'Main site', labelAr: 'الموقع الرئيسي', url: 'https://www.helpdock.com' },
        { labelEn: 'Service status', labelAr: 'حالة الخدمة', url: 'https://status.helpdock.com' },
      ],
      footer: [
        { labelEn: 'Privacy', labelAr: 'الخصوصية', url: 'https://www.helpdock.com/privacy' },
        { labelEn: 'Terms', labelAr: 'الشروط', url: 'https://www.helpdock.com/terms' },
      ],
    },
    customCss: '.hd-header { border-block-end-width: 2px; }',
    url: 'https://help.helpdock.test/',
  };
  readonly #images = new Map<string, HcMedia>();

  constructor() {
    const fixture = seed();
    this.categories = fixture.categories;
    this.sections = fixture.sections;
    this.stored = fixture.stored;
  }

  async structure(): Promise<HcStructure> {
    await delay();
    return {
      defaultLocale: 'en',
      timezone: 'Asia/Riyadh',
      categories: [...this.categories].sort((a, b) => a.position - b.position),
      sections: [...this.sections].sort((a, b) => a.position - b.position),
      articles: this.stored.map(summary).sort((a, b) => a.position - b.position),
    };
  }

  async createCategory(_brandId: string, request: HcCategoryCreateRequest): Promise<HcCategory> {
    await delay();
    const created: HcCategory = {
      id: crypto.randomUUID(),
      slug: this.#slug(this.categories, request.slug, request.names.en, 'category'),
      names: request.names,
      descriptions: request.descriptions ?? { en: '', ar: '' },
      position: this.categories.length,
    };
    this.categories.push(created);
    return created;
  }

  async updateCategory(
    _brandId: string,
    categoryId: string,
    request: HcCategoryUpdateRequest,
  ): Promise<HcCategory> {
    await delay();
    const found = this.#find(this.categories, categoryId);
    const slug =
      request.slug === undefined
        ? found.slug
        : this.#slug(
            this.categories.filter((row) => row.id !== categoryId),
            request.slug,
            '',
            '',
          );
    Object.assign(found, { ...request, slug });
    return found;
  }

  async deleteCategory(_brandId: string, categoryId: string): Promise<void> {
    await delay();
    if (this.sections.some((section) => section.categoryId === categoryId)) {
      throw new HelpCenterError('not-empty');
    }
    this.categories = this.categories.filter((row) => row.id !== categoryId);
  }

  async createSection(_brandId: string, request: HcSectionCreateRequest): Promise<HcSection> {
    await delay();
    const created: HcSection = {
      id: crypto.randomUUID(),
      categoryId: request.categoryId,
      slug: this.#slug(this.sections, request.slug, request.names.en, 'section'),
      names: request.names,
      position: this.sections.filter((row) => row.categoryId === request.categoryId).length,
    };
    this.sections.push(created);
    return created;
  }

  async updateSection(
    _brandId: string,
    sectionId: string,
    request: HcSectionUpdateRequest,
  ): Promise<HcSection> {
    await delay();
    const found = this.#find(this.sections, sectionId);
    Object.assign(found, request);
    return found;
  }

  async deleteSection(_brandId: string, sectionId: string): Promise<void> {
    await delay();
    if (this.stored.some((row) => row.article.sectionId === sectionId)) {
      throw new HelpCenterError('not-empty');
    }
    this.sections = this.sections.filter((row) => row.id !== sectionId);
  }

  async reorder(
    _brandId: string,
    kind: 'categories' | 'sections' | 'articles',
    request: HcReorderRequest,
  ): Promise<HcStructure> {
    for (const [position, rowId] of request.ids.entries()) {
      if (kind === 'categories') {
        this.#find(this.categories, rowId).position = position;
      } else if (kind === 'sections') {
        Object.assign(this.#find(this.sections, rowId), {
          position,
          categoryId: request.parentId ?? '',
        });
      } else {
        Object.assign(this.#stored(rowId).article, { position, sectionId: request.parentId ?? '' });
      }
    }
    return this.structure();
  }

  async article(_brandId: string, articleId: string): Promise<HcArticle> {
    await delay();
    return this.#view(this.#stored(articleId));
  }

  async createArticle(_brandId: string, request: HcArticleCreateRequest): Promise<HcArticle> {
    await delay();
    const created: Stored = {
      article: {
        id: crypto.randomUUID(),
        sectionId: request.sectionId,
        slug: this.#slug(
          this.stored.map((row) => row.article),
          request.slug,
          request.title,
          'article',
        ),
        position: this.stored.filter((row) => row.article.sectionId === request.sectionId).length,
      },
      versions: [
        version(request.locale, request.title, 'draft', {
          bodyHtml: '',
          updatedAt: new Date().toISOString(),
        }),
      ],
      activity: [],
    };
    this.stored.push(created);
    this.#log(created, 'created', request.locale);
    return this.#view(created);
  }

  async updateArticle(
    _brandId: string,
    articleId: string,
    request: HcArticleUpdateRequest,
  ): Promise<HcArticle> {
    await delay();
    const found = this.#stored(articleId);
    if (request.slug !== undefined && request.slug !== found.article.slug) {
      found.article.slug = this.#slug(
        this.stored.map((row) => row.article).filter((row) => row.id !== articleId),
        request.slug,
        '',
        '',
      );
      this.#log(found, 'slug_changed', null, found.article.slug);
    }
    if (request.sectionId !== undefined) {
      found.article.sectionId = request.sectionId;
    }
    return this.#view(found);
  }

  async deleteArticle(_brandId: string, articleId: string): Promise<void> {
    await delay();
    if (this.#stored(articleId).versions.some((row) => row.publishedAt !== null)) {
      throw new HelpCenterError('was-published');
    }
    this.stored = this.stored.filter((row) => row.article.id !== articleId);
  }

  async saveVersion(
    _brandId: string,
    articleId: string,
    locale: HcLocale,
    request: HcVersionSaveRequest,
  ): Promise<HcArticle> {
    await delay();
    const found = this.#stored(articleId);
    const existing = found.versions.find((row) => row.locale === locale);
    const now = new Date().toISOString();
    if (existing === undefined) {
      found.versions.push(version(locale, request.title, 'draft', { ...request, updatedAt: now }));
      this.#log(found, 'created', locale);
    } else {
      Object.assign(existing, request, {
        updatedAt: now,
        updatedByName: MOCK_USER.name,
        hasUnpublishedChanges: existing.publishedAt !== null,
      });
      if (found.activity[0]?.action !== 'edited') {
        this.#log(found, 'edited', locale);
      }
    }
    return this.#view(found);
  }

  async setStatus(
    _brandId: string,
    articleId: string,
    locale: HcLocale,
    request: HcVersionStatusRequest,
  ): Promise<HcArticle> {
    await delay();
    const found = this.#stored(articleId);
    const row = found.versions.find((candidate) => candidate.locale === locale);
    if (row === undefined) {
      throw new HelpCenterError('not-empty');
    }
    const now = new Date();
    if (request.status === 'scheduled') {
      const at = new Date(request.scheduledAt ?? Number.NaN);
      if (!(at.getTime() > now.getTime())) {
        throw new HelpCenterError('schedule-in-past');
      }
      Object.assign(row, { status: 'scheduled', scheduledAt: at.toISOString() });
      this.#log(found, 'scheduled', locale, at.toISOString());
    } else if (request.status === 'published') {
      Object.assign(row, {
        status: 'published',
        scheduledAt: null,
        publishedAt: now.toISOString(),
        publishedByName: MOCK_USER.name,
        hasUnpublishedChanges: false,
      });
      this.#log(found, 'published', locale);
    } else {
      Object.assign(row, { status: request.status, scheduledAt: null });
      this.#log(found, request.status === 'draft' ? 'unpublished' : 'archived', locale);
    }
    return this.#view(found);
  }

  async setVisibility(
    _brandId: string,
    articleId: string,
    locale: HcLocale,
    visibility: HcVisibility,
  ): Promise<HcArticle> {
    await delay();
    const found = this.#stored(articleId);
    const row = found.versions.find((candidate) => candidate.locale === locale);
    if (row !== undefined && row.visibility !== visibility) {
      row.visibility = visibility;
      this.#log(found, 'visibility_changed', locale, visibility);
    }
    return this.#view(found);
  }

  async settings(): Promise<HcSettings> {
    await delay();
    return { ...this.#settings };
  }

  async updateSettings(_brandId: string, settings: HcSettings): Promise<HcSettings> {
    await delay();
    this.#settings = { ...settings };
    return { ...this.#settings };
  }

  async presignImage(
    _brandId: string,
    _request: HcMediaPresignRequest,
  ): Promise<HcMediaPresignResponse> {
    const mediaId = crypto.randomUUID();
    this.#images.set(mediaId, {
      id: mediaId,
      status: 'pending',
      src: null,
      width: null,
      height: null,
      rejectReason: null,
    });
    return {
      mediaId,
      url: `https://bucket.test/${mediaId}`,
      headers: {},
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  /** The fixture keeps the bytes as a data URL, so the editor can show what was pasted. */
  async uploadImage(upload: HcMediaPresignResponse, file: Blob): Promise<void> {
    const src = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(String(reader.result));
      };
      reader.readAsDataURL(file);
    });
    const image = this.#images.get(upload.mediaId);
    if (image !== undefined) {
      this.#images.set(upload.mediaId, { ...image, src });
    }
  }

  async confirmImage(_brandId: string, mediaId: string): Promise<HcMedia> {
    const image = this.#images.get(mediaId);
    if (image === undefined) {
      throw new HelpCenterError('not-empty');
    }
    const ready: HcMedia = { ...image, status: 'ready', width: 1200, height: 640 };
    this.#images.set(mediaId, ready);
    return ready;
  }

  async image(brandId: string, mediaId: string): Promise<HcMedia> {
    return this.confirmImage(brandId, mediaId);
  }

  /** The Insights board's figures, narrowed and sorted the way the api does. */
  async insights(_brandId: string, query: HcInsightsQuery): Promise<HcInsights> {
    await delay();
    const inLocale = <T extends { locale: HcLocale }>(rows: readonly T[]): T[] =>
      rows.filter((row) => query.locale === undefined || row.locale === query.locale);
    const articles = [...MOCK_ARTICLE_STATS].sort((a, b) =>
      query.sort === 'least_helpful'
        ? Number(a.votes === 0) - Number(b.votes === 0) ||
          a.helpful / Math.max(a.votes, 1) - b.helpful / Math.max(b.votes, 1)
        : b.views - a.views,
    );

    return {
      days: query.days,
      locale: query.locale ?? null,
      topSearches: inLocale(MOCK_TOP_SEARCHES),
      // The fixture's last week found an answer to every search, for the empty state.
      zeroResultSearches: query.days === 7 ? [] : inLocale(MOCK_ZERO_RESULT_SEARCHES),
      articles: query.locale === 'ar' ? articles.slice(0, 2) : articles,
    };
  }

  async site(): Promise<HcSite> {
    await delay();
    return structuredClone(this.#site);
  }

  async saveAppearance(
    _brandId: string,
    request: HcAppearanceUpdateRequest,
  ): Promise<HcAppearance> {
    await delay();
    const image = (mediaId: string | null) => {
      if (mediaId === null) {
        return null;
      }
      const found = this.#images.get(mediaId);
      if (found?.status !== 'ready' || found.src === null) {
        throw new HelpCenterError('media-not-ready');
      }
      return { mediaId, src: found.src, width: found.width, height: found.height };
    };
    this.#site.appearance = {
      theme: request.theme,
      logo: image(request.logoMediaId),
      favicon: image(request.faviconMediaId),
    };
    return structuredClone(this.#site.appearance);
  }

  async saveHome(_brandId: string, request: HcHomeLayout): Promise<HcHomeLayout> {
    await delay();
    if (
      request.featuredArticleIds.some(
        (articleId) => !this.stored.some((entry) => entry.article.id === articleId),
      )
    ) {
      throw new HelpCenterError('unknown-article');
    }
    this.#site.home = structuredClone(request);
    return structuredClone(request);
  }

  async saveLinks(_brandId: string, request: HcLinks): Promise<HcLinks> {
    await delay();
    this.#site.links = structuredClone(request);
    return structuredClone(request);
  }

  /**
   * The api's sanitiser keeps an allowlist (`custom-css.ts`); the fixture only
   * imitates its three most common refusals, which is what the screen needs
   * to show a list of removals.
   */
  async saveCustomCss(_brandId: string, css: string): Promise<HcCustomCssResult> {
    await delay();
    const removed: HcCssRemoval[] = [];
    const kept = css
      .split('\n')
      .filter((line) => {
        const reason = /^\s*@import/.test(line)
          ? 'import'
          : /url\(\s*['"]?https?:/.test(line)
            ? 'url'
            : /position:\s*fixed/.test(line)
              ? 'fixed'
              : null;
        if (reason !== null) {
          removed.push({ rule: line.trim(), reason });
        }
        return reason === null;
      })
      .join('\n')
      .trim();
    this.#site.customCss = kept;
    return { css: kept, removed };
  }

  async staffPass(brandId: string, request: HcStaffPassRequest): Promise<HcStaffPassResponse> {
    await delay();
    const path =
      request.preview === undefined
        ? (request.path ?? '/en')
        : `/${request.preview.locale}/articles/preview?preview=1`;
    return {
      url: `https://help.helpdock.test/_hd/staff?pass=mock-${brandId}&to=${encodeURIComponent(path)}`,
    };
  }

  #slug(
    rows: readonly { slug: string }[],
    chosen: string | undefined,
    from: string,
    fallback: string,
  ): string {
    if (chosen !== undefined) {
      if (rows.some((row) => row.slug === chosen)) {
        throw new HelpCenterError('slug-taken');
      }
      return chosen;
    }
    const base = slugify(from, fallback);
    let candidate = base;
    for (let n = 2; rows.some((row) => row.slug === candidate); n += 1) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  #find<T extends { id: string }>(rows: readonly T[], rowId: string): T {
    const found = rows.find((row) => row.id === rowId);
    if (found === undefined) {
      throw new HelpCenterError('not-empty');
    }
    return found;
  }

  #stored(articleId: string): Stored {
    const found = this.stored.find((row) => row.article.id === articleId);
    if (found === undefined) {
      throw new HelpCenterError('not-empty');
    }
    return found;
  }

  #log(
    stored: Stored,
    action: HcActivityAction,
    locale: HcLocale | null,
    detail: string | null = null,
  ): void {
    stored.activity.unshift({
      id: crypto.randomUUID(),
      action,
      locale,
      actorName: MOCK_USER.name,
      at: new Date().toISOString(),
      detail,
    });
  }

  #view(stored: Stored): HcArticle {
    return {
      ...stored.article,
      versions: stored.versions.map((row) => ({ ...row })),
      activity: stored.activity.slice(0, 10),
    };
  }
}
