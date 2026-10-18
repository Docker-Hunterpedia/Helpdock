const article = {
  id: '7001',
  translationId: '8001',
  locale: 'en-US',
  sourceLocale: 'en-US',
  title: 'Original article',
  status: 'Published',
  latestVersionStatus: 'Draft',
  latestVersion: '2.1',
  latestPublishedVersion: '2.0',
  permission: 'ALL',
  isTrashed: false,
  createdTime: '2013-11-01T00:00:00.000Z',
  modifiedTime: '2020-01-01T00:00:00.000Z',
  rootCategoryId: '2001',
  categoryId: '4001',
  summary: 'A shortened list summary',
};
const file = {
  resourceId: 'mvfyda9fcc4df229b4065a04fba88a5b81b33',
  extension: 'pdf',
  name: 'original-manual.pdf',
  size: '37',
  createdTime: '2019-12-01T00:00:00.000Z',
  viewUrl:
    'https://desk.zoho.com/api/v1/articles/7001/translations/en-US/attachments/mvfyda9fcc4df229b4065a04fba88a5b81b33/content?orgId=2389290',
  downloadUrl:
    'https://desk.zoho.com/api/v1/articles/7001/translations/en-US/attachments/mvfyda9fcc4df229b4065a04fba88a5b81b33/content?orgId=2389290&inline=false',
};

/** Native wire examples keep the unpublished revision distinct from the public copy. */
export const zohoArticleFixture = [
  {
    ...article,
    currentVersion: '2.1',
    answer: '<h2>Unpublished edit</h2><p>Staff-only working changes.</p>',
    attachments: [file],
  },
  {
    ...article,
    currentVersion: '2.0',
    title: 'Published article',
    modifiedTime: '2019-12-01T00:00:00.000Z',
    answer: '<h2>Published answer</h2><p>Original customer-facing content.</p>',
    attachments: [],
  },
  {
    ...article,
    locale: 'ar-SY',
    translationId: '8002',
    latestVersion: '1.0',
    latestVersionStatus: 'Published',
    latestPublishedVersion: '1.0',
    currentVersion: '1.0',
    title: 'المقالة الأصلية',
    answer: '<h2>الإجابة المنشورة</h2><p>المحتوى الأصلي للقراء.</p>',
    attachments: [],
  },
  {
    ...article,
    id: '7002',
    translationId: '8003',
    status: 'Draft',
    latestVersionStatus: 'Draft',
    latestVersion: '0.1',
    latestPublishedVersion: null,
    currentVersion: '0.1',
    permission: 'AGENTS',
    answer: '<p>Private draft</p>',
    attachments: [],
  },
];
