import { type Db, withSystem } from '@helpdock/db';
import { sql } from 'drizzle-orm';

/**
 * DOMAIN-RULES §14's help center: 2 000 articles in two locales in the
 * measured brand, published and public, under 8 categories of 5 sections.
 *
 * Written with `INSERT … SELECT generate_series(…)` in the brand's own system
 * transaction, as `dataset.ts` writes tickets: the rows pass the same policies
 * the api's writes do, and the whole help center takes seconds rather than the
 * minutes four thousand publishes over HTTP would.
 *
 * Each article's body is a few hundred words, about what a real one is, so a
 * render costs what it would.
 */

export interface HelpCenterScale {
  readonly articles: number;
  readonly categories: number;
  readonly sectionsPerCategory: number;
}

export const DOMAIN_RULES_14_HELP_CENTER: HelpCenterScale = {
  articles: 2_000,
  categories: 8,
  sectionsPerCategory: 5,
};

export interface SeededHelpCenter {
  readonly categorySlugs: readonly string[];
  readonly sectionSlugs: readonly string[];
  readonly articleSlugs: readonly string[];
}

const PARAGRAPH_EN =
  'To change this setting, open your account, choose the section that applies to the order, and follow the steps on the screen. If the option is not there, your plan may not include it; the billing page says which features each plan has. Changes take effect at once and apply to new orders only.';
const PARAGRAPH_AR =
  'لتغيير هذا الإعداد، افتح حسابك واختر القسم الخاص بالطلب ثم اتبع الخطوات على الشاشة. إذا لم يظهر الخيار فقد لا تشمله خطتك؛ توضح صفحة الفوترة الميزات المتاحة في كل خطة. تسري التغييرات فورًا وتنطبق على الطلبات الجديدة فقط.';

const body = (paragraph: string): string =>
  Array.from({ length: 6 }, (_, index) =>
    index % 3 === 2 ? `<h2>Step ${index}</h2><p>${paragraph}</p>` : `<p>${paragraph}</p>`,
  ).join('');

export const seedHelpCenter = async (
  db: Db,
  brandId: string,
  scale: HelpCenterScale,
): Promise<SeededHelpCenter> => {
  const sections = scale.categories * scale.sectionsPerCategory;

  await withSystem(db, brandId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO hc_categories (id, brand_id, slug, names, descriptions, position)
      SELECT gen_random_uuid(), ${brandId}::uuid, 'category-' || n,
             jsonb_build_object('en', 'Category ' || n, 'ar', 'الفئة ' || n),
             jsonb_build_object('en', 'Answers about topic ' || n, 'ar', 'إجابات حول الموضوع ' || n),
             n
      FROM generate_series(1, ${scale.categories}) AS n
    `);
    await tx.execute(sql`
      INSERT INTO hc_sections (id, brand_id, category_id, slug, names, position)
      SELECT gen_random_uuid(), ${brandId}::uuid, c.id, 'section-' || c.position || '-' || s,
             jsonb_build_object('en', 'Section ' || c.position || '.' || s, 'ar', 'القسم ' || c.position || '.' || s),
             s
      FROM hc_categories c CROSS JOIN generate_series(1, ${scale.sectionsPerCategory}) AS s
    `);
    await tx.execute(sql`
      WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY slug) - 1 AS rn FROM hc_sections
      )
      INSERT INTO hc_articles (id, brand_id, section_id, slug, position)
      SELECT gen_random_uuid(), ${brandId}::uuid, numbered.id, 'article-' || n, n
      FROM generate_series(1, ${scale.articles}) AS n
      JOIN numbered ON numbered.rn = n % ${sections}
    `);
    await tx.execute(sql`
      INSERT INTO hc_article_versions (
        id, brand_id, article_id, locale, status, visibility, title, description, body_html,
        published_title, published_description, published_body_html, published_body_text, published_at
      )
      SELECT gen_random_uuid(), ${brandId}::uuid, a.id, v.locale::locale, 'published', 'public',
             v.title || a.position, v.description, v.html,
             v.title || a.position, v.description, v.html, v.text, now() - random() * interval '365 days'
      FROM hc_articles a
      CROSS JOIN (VALUES
        ('en', 'How to change setting ', 'Steps for changing a setting on an order.', ${body(PARAGRAPH_EN)}, ${PARAGRAPH_EN}),
        ('ar', 'كيفية تغيير الإعداد ', 'خطوات تغيير إعداد في الطلب.', ${body(PARAGRAPH_AR)}, ${PARAGRAPH_AR})
      ) AS v(locale, title, description, html, text)
    `);
  });

  const range = (count: number, name: (n: number) => string) =>
    Array.from({ length: count }, (_, index) => name(index + 1));

  return {
    categorySlugs: range(scale.categories, (n) => `category-${n}`),
    sectionSlugs: range(scale.categories, (n) => `section-${n}-1`),
    articleSlugs: range(scale.articles, (n) => `article-${n}`),
  };
};
