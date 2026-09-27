import { describe, expect, it } from 'vitest';
import { HelpCenterError } from './api.js';
import { MOCK_HELP_CENTER, MockHelpCenterApi } from './mock-api.js';

/**
 * The fixture keeps the api's rules, so a screen that handles a refusal here
 * handles the real one. These are those rules.
 */

const BRAND = 'brand';
const M = MOCK_HELP_CENTER;

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof HelpCenterError ? error.reason : 'other'),
  );

describe('MockHelpCenterApi', () => {
  it('seeds the artboard’s Refunds section, dashed Arabic chip and all', async () => {
    const structure = await new MockHelpCenterApi().structure();
    const refunds = structure.articles.filter((row) => row.sectionId === M.sections.refunds);

    expect(refunds).toHaveLength(6);
    expect(refunds.find((row) => row.id === M.articles.closedCard)?.versions).toHaveLength(1);
  });

  it('suffixes a derived slug and refuses a typed one that is taken', async () => {
    const api = new MockHelpCenterApi();
    const first = await api.createCategory(BRAND, { names: { en: 'Billing', ar: '' } });
    const second = await api.createCategory(BRAND, { names: { en: 'Billing', ar: '' } });

    expect([first.slug, second.slug]).toEqual(['billing', 'billing-2']);
    expect(await reason(api.updateCategory(BRAND, second.id, { slug: 'billing' }))).toBe(
      'slug-taken',
    );
    await expect(api.updateCategory(BRAND, second.id, { slug: 'fees' })).resolves.toMatchObject({
      slug: 'fees',
    });
  });

  it('refuses to delete what still has children, or an article that was published', async () => {
    const api = new MockHelpCenterApi();

    expect(await reason(api.deleteCategory(BRAND, M.categories.returns))).toBe('not-empty');
    expect(await reason(api.deleteSection(BRAND, M.sections.refunds))).toBe('not-empty');
    expect(await reason(api.deleteArticle(BRAND, M.articles.timelines))).toBe('was-published');

    await api.deleteArticle(BRAND, M.articles.restocking);
    await api.deleteSection(BRAND, M.sections.signIn);
    await api.deleteCategory(BRAND, M.categories.account);
    const structure = await api.structure();
    expect(structure.categories.map((row) => row.id)).not.toContain(M.categories.account);
  });

  it('creates a section, an article and its versions, and logs what happened', async () => {
    const api = new MockHelpCenterApi();
    const section = await api.createSection(BRAND, {
      categoryId: M.categories.orders,
      names: { en: 'Cancelling', ar: '' },
    });
    await api.updateSection(BRAND, section.id, { names: { en: 'Cancelling orders', ar: '' } });
    const article = await api.createArticle(BRAND, {
      sectionId: section.id,
      locale: 'en',
      title: 'Cancel an order',
    });

    await api.saveVersion(BRAND, article.id, 'en', {
      title: 'Cancel',
      description: '',
      bodyHtml: '<p>a</p>',
    });
    await api.saveVersion(BRAND, article.id, 'en', {
      title: 'Cancel',
      description: '',
      bodyHtml: '<p>b</p>',
    });
    await api.saveVersion(BRAND, article.id, 'ar', {
      title: 'إلغاء',
      description: '',
      bodyHtml: '',
    });
    await api.setVisibility(BRAND, article.id, 'ar', 'internal');
    await api.setStatus(BRAND, article.id, 'en', { status: 'published' });
    await api.saveVersion(BRAND, article.id, 'en', {
      title: 'Cancel',
      description: '',
      bodyHtml: '<p>c</p>',
    });
    await api.setStatus(BRAND, article.id, 'en', { status: 'archived' });
    await api.setStatus(BRAND, article.id, 'ar', { status: 'draft' });
    const moved = await api.updateArticle(BRAND, article.id, {
      slug: 'cancel',
      sectionId: M.sections.tracking,
    });

    expect(moved).toMatchObject({ slug: 'cancel', sectionId: M.sections.tracking });
    expect(moved.versions.map((row) => [row.locale, row.status, row.visibility])).toEqual([
      ['en', 'archived', 'public'],
      ['ar', 'draft', 'internal'],
    ]);
    expect(moved.activity.map((row) => row.action)).toEqual([
      'slug_changed',
      'unpublished',
      'archived',
      'edited',
      'published',
      'visibility_changed',
      'created',
      'edited',
      'created',
    ]);
  });

  it('schedules only in the future', async () => {
    const api = new MockHelpCenterApi();
    const past = api.setStatus(BRAND, M.articles.restocking, 'en', {
      status: 'scheduled',
      scheduledAt: '2020-01-01T00:00:00Z',
    });
    expect(await reason(past)).toBe('schedule-in-past');

    const at = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await api.setStatus(BRAND, M.articles.restocking, 'en', {
      status: 'scheduled',
      scheduledAt: at,
    });
    expect(scheduled.versions[0]).toMatchObject({ status: 'scheduled', scheduledAt: at });
    expect(
      await reason(api.setStatus(BRAND, M.articles.restocking, 'ar', { status: 'draft' })),
    ).toBe('not-empty');
  });

  it('moves an article and a section when reordered into another parent', async () => {
    const api = new MockHelpCenterApi();
    const structure = await api.reorder(BRAND, 'articles', {
      parentId: M.sections.tracking,
      ids: [M.articles.timelines, M.articles.whereIsMyOrder],
    });
    expect(structure.articles.find((row) => row.id === M.articles.timelines)?.sectionId).toBe(
      M.sections.tracking,
    );

    await api.reorder(BRAND, 'sections', {
      parentId: M.categories.orders,
      ids: [M.sections.damaged],
    });
    const categories = await api.reorder(BRAND, 'categories', {
      parentId: null,
      ids: [M.categories.shipping, M.categories.orders],
    });
    expect(categories.categories[0]?.id).toBe(M.categories.shipping);
    expect(categories.sections.find((row) => row.id === M.sections.damaged)?.categoryId).toBe(
      M.categories.orders,
    );
  });

  it('keeps the help center’s access, and turns an upload into a ready image', async () => {
    const api = new MockHelpCenterApi();
    await api.updateSettings(BRAND, { access: 'internal_only' });
    expect(await api.settings()).toEqual({ access: 'internal_only' });

    const upload = await api.presignImage(BRAND, { fileName: 'a.png', mime: 'image/png', size: 3 });
    await api.uploadImage(upload, new Blob(['png'], { type: 'image/png' }));
    const media = await api.image(BRAND, upload.mediaId);
    expect(media).toMatchObject({ status: 'ready', width: 1200 });
    expect(media.src).toMatch(/^data:image\/png;base64,/);
    expect(await reason(api.confirmImage(BRAND, 'missing'))).toBe('not-empty');
  });
});
