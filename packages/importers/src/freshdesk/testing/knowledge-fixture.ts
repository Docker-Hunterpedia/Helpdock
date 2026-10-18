import type { FreshdeskFixture } from './fake-freshdesk.js';

const dates = { created_at: '2020-01-01T10:00:00Z', updated_at: '2020-01-02T10:00:00Z' };
const category = {
  id: 601,
  name: 'Original help center',
  description: 'Source category',
  ...dates,
};
const root = {
  id: 701,
  name: 'Staff only',
  description: 'Restricted parent',
  parent_folder_id: null,
  visibility: 3,
  sub_folders_count: 1,
  articles_count: 0,
  ...dates,
};
const child = {
  id: 702,
  name: 'Nested guides',
  description: 'Public child under restricted parent',
  parent_folder_id: 701,
  visibility: 1,
  sub_folders_count: 0,
  articles_count: 1,
  ...dates,
};
const article = {
  id: 801,
  category_id: 601,
  folder_id: 702,
  title: 'Original article',
  description: '<p>Complete original guide</p>',
  status: 2,
  agent_id: 301,
  ...dates,
};

/** Child-first category listing exercises independent ancestor privacy resolution. */
export const freshdeskKnowledgeFixture = {
  helpdesk_settings: { primary_language: 'en', supported_languages: ['ar'] },
  categories: [category],
  folders: { '601': [child, root] },
  subfolders: { '701': [child] },
  articles: { '702': [article] },
  translations: {
    'category:601': {
      ar: { ...category, name: 'مركز المساعدة الأصلي', description: 'تصنيف المصدر' },
    },
    'folder:701': { ar: { ...root, name: 'للموظفين فقط', description: 'مجلد رئيسي مقيّد' } },
    'folder:702': {
      ar: { ...child, name: 'أدلة متداخلة', description: 'مجلد فرعي ضمن مجلد مقيّد' },
    },
    'article:801': {
      ar: {
        ...article,
        title: 'المقال الأصلي',
        description: '<p>الدليل الأصلي الكامل</p>',
        status: 1,
      },
    },
  },
} satisfies FreshdeskFixture;
